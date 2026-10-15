/**
 * §6b Chunk B — Tests: report snapshots, subagent run tracking, browser-session endpoint.
 *
 * Tests use the same `buildApp()` + in-memory DB pattern as the other integration tests.
 * No real filesystem writes — EVERYTHINGAPP_ARTIFACTS_DIR is set to a temp dir that's
 * cleaned up after each test.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildApp } from '../server.js';
import type { LlmClient } from '../llm-loop.js';
import { openDb, runMigrations } from '../db.js';

// ─── Minimal Anthropic mock (never actually called by these tests) ──────────
const fakeAnthropicClient = {
  messages: {
    create: async () => {
      throw new Error('Not expected to be called in artifact/subagent tests');
    },
  },
} as unknown as LlmClient;

const AUTH = 'test-token-chunk-b';

function request(
  server: http.Server,
  method: string,
  path: string,
  body?: Buffer | string,
  contentType?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const bodyBuf = body
      ? typeof body === 'string'
        ? Buffer.from(body)
        : body
      : undefined;

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        method,
        path,
        headers: {
          Authorization: `Bearer ${AUTH}`,
          ...(contentType ? { 'Content-Type': contentType } : {}),
          ...(bodyBuf ? { 'Content-Length': String(bodyBuf.length) } : {}),
          ...(extraHeaders ?? {}),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function listen(app: http.RequestListener): Promise<http.Server> {
  return new Promise(resolve => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ─── Suite: Artifacts API ────────────────────────────────────────────────────

let server: http.Server;
let stopApp: () => void;
let tmpDir: string;
let convId: string;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-chunk-b-test-'));
  process.env['EVERYTHINGAPP_ARTIFACTS_DIR'] = tmpDir;

  const db = openDb(':memory:');
  runMigrations(db);

  const built = await buildApp({
    db,
    connections: [],
    llm: fakeAnthropicClient,
    authToken: AUTH,
    config: { model: '@test/model', autoApproveTools: [] },
  });
  stopApp = built.stop;
  server = await listen(built.app);

  // Create a conversation for artifact association
  const res = await request(server, 'POST', '/api/conversations', JSON.stringify({ title: 'test' }), 'application/json');
  convId = (res.body as { id: string }).id;
});

after(() => {
  stopApp();
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['EVERYTHINGAPP_ARTIFACTS_DIR'];
});

// ─── 2. Subagent run endpoints ────────────────────────────────────────────────

test('GET /api/conversations/:id/subagent-runs returns empty array initially', async () => {
  // Fresh conversation with no runs
  const newConv = await request(server, 'POST', '/api/conversations', JSON.stringify({ title: 'subagent test' }), 'application/json');
  const { id: newConvId } = newConv.body as { id: string };

  const res = await request(server, 'GET', `/api/conversations/${newConvId}/subagent-runs`);
  assert.equal(res.status, 200);
  const { runs } = res.body as { runs: unknown[] };
  assert.ok(Array.isArray(runs) && runs.length === 0);
});

test('GET /api/subagent-runs/:id returns 404 for unknown run id', async () => {
  const res = await request(server, 'GET', '/api/subagent-runs/nonexistent-run');
  assert.equal(res.status, 404);
});

// ─── 3. DB-level artifact helpers ─────────────────────────────────────────────

test('createArtifact + getArtifact round-trip (report snapshots)', async () => {
  const { openDb, runMigrations, createArtifact, getArtifact } = await import('../db.js');
  const db2 = openDb(':memory:');
  runMigrations(db2);

  const row = createArtifact(db2, { conversationId: null, filename: 'test.png', mimeType: 'image/png', sizeBytes: 42, source: 'report-pin' });
  assert.ok(row.id);
  assert.equal(row.filename, 'test.png');
  assert.equal(getArtifact(db2, row.id)!.id, row.id);
  assert.equal(getArtifact(db2, 'nope'), null);
});

// ─── 4. DB-level subagent-run helpers ─────────────────────────────────────────

test('createSubagentRun + resolveSubagentRun + listSubagentRuns round-trip', async () => {
  const { openDb, runMigrations, createConversation, createSubagentRun, resolveSubagentRun, listSubagentRuns, getSubagentRun } = await import('../db.js');
  const db3 = openDb(':memory:');
  runMigrations(db3);

  const conv = createConversation(db3, { title: 'parent', model: '@test/model' });
  const run = createSubagentRun(db3, {
    conversationId: conv.id,
    goal: 'Do something',
    model: '@test/small',
    allowedTools: ['sandbox__bash'],
  });

  assert.ok(run.id);
  assert.equal(run.status, 'running');
  assert.equal(run.goal, 'Do something');
  assert.deepEqual(run.allowedTools, ['sandbox__bash']);

  resolveSubagentRun(db3, run.id, { summary: 'Done!', artifactIds: [] });

  const resolved = getSubagentRun(db3, run.id);
  assert.ok(resolved);
  assert.equal(resolved.status, 'done');
  assert.equal(resolved.result?.summary, 'Done!');

  const list = listSubagentRuns(db3, conv.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, run.id);
});

test('failSubagentRun marks the run as error with a message', async () => {
  const { openDb, runMigrations, createConversation, createSubagentRun, failSubagentRun, getSubagentRun } = await import('../db.js');
  const db4 = openDb(':memory:');
  runMigrations(db4);

  const conv = createConversation(db4, { title: 'parent', model: '@test/model' });
  const run = createSubagentRun(db4, {
    conversationId: conv.id,
    goal: 'Fail intentionally',
    model: '@test/small',
    allowedTools: [],
  });

  failSubagentRun(db4, run.id, 'API error: rate limited');

  const failed = getSubagentRun(db4, run.id);
  assert.ok(failed);
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'API error: rate limited');
  assert.equal(failed.result, null);
});
