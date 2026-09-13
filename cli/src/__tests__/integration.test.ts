import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Anthropic from '@anthropic-ai/sdk';
import { buildApp, type BuiltApp } from '../server.js';
import { openDb, runMigrations, getMessages } from '../db.js';

type Db = ReturnType<typeof openDb>;

const AUTH_TOKEN = 'integration-test-token';
const FAKE_REPLY_TEXT = 'Hello from the fake model.';

/** Minimally-valid fake Anthropic.Message — mirrors the helper in anthropic-loop.test.ts. */
function fakeMessage(text: string): Anthropic.Message {
  return {
    id: 'msg_fake',
    container: null,
    content: [{ type: 'text', text, citations: null }],
    model: 'claude-sonnet-5',
    role: 'assistant',
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
  } as unknown as Anthropic.Message;
}

/**
 * No tool use, no MCP servers, no batch jobs in this scenario — the
 * `messages.batches.*` methods only need to exist to satisfy the
 * AnthropicBatchLike half of buildApp's combined client type. They throw if
 * ever actually called, so a future test that *does* exercise batch mode
 * can't silently pass against a stub that quietly does nothing.
 */
function fakeAnthropicClient(replyText: string) {
  return {
    messages: {
      async create() {
        return fakeMessage(replyText);
      },
      batches: {
        create() { throw new Error('not exercised by this test'); },
        retrieve() { throw new Error('not exercised by this test'); },
        results() { throw new Error('not exercised by this test'); },
      },
    },
  };
}

interface JsonResponse { status: number; json: Record<string, unknown> }

function jsonRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'content-type': 'application/json',
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
          ...extraHeaders,
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} });
          } catch (err) {
            reject(new Error(`non-JSON response from ${path}: ${text} (${(err as Error).message})`));
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Reads the SSE stream at `path` until `targetEvent` appears or `timeoutMs` elapses. */
function watchSse(port: number, path: string, targetEvent: string, timeoutMs = 5000): { stop: () => void; seen: Promise<string> } {
  let buffer = '';
  // Initialized with no-op placeholders (not left unassigned) purely to satisfy
  // strict definite-assignment analysis — the Promise executor below runs
  // synchronously and immediately overwrites both before either is ever called.
  let resolveSeen: (raw: string) => void = () => {};
  let rejectSeen: (err: Error) => void = () => {};
  const seen = new Promise<string>((res, rej) => {
    resolveSeen = res;
    rejectSeen = rej;
  });

  const req = http.get({ host: '127.0.0.1', port, path }, res => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.includes(`event: ${targetEvent}`)) resolveSeen(buffer);
    });
  });
  req.on('error', err => rejectSeen(err));

  const timer = setTimeout(() => rejectSeen(new Error(`timed out waiting for SSE event '${targetEvent}'`)), timeoutMs);
  void seen.finally(() => clearTimeout(timer));

  return { stop: () => req.destroy(), seen };
}

describe('integration: end-to-end turn over HTTP', () => {
  let db: Db;
  let built: BuiltApp;
  let server: http.Server;
  let port: number;

  before(async () => {
    db = openDb(':memory:');
    runMigrations(db);
    built = await buildApp({
      db,
      connections: [],
      anthropic: fakeAnthropicClient(FAKE_REPLY_TEXT),
      authToken: AUTH_TOKEN,
      config: { model: 'claude-sonnet-5', autoApproveTools: [], webSearchEnabled: false },
    });
    server = built.app.listen(0);
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    built.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  });

  it('rejects requests without a valid auth token', async () => {
    const res = await jsonRequest(port, 'GET', '/api/conversations');
    assert.equal(res.status, 401);
  });

  it('drives a full turn: create conversation, send message, stream SSE, persist to SQLite', async () => {
    const authHeader = { authorization: `Bearer ${AUTH_TOKEN}` };

    const created = await jsonRequest(port, 'POST', '/api/conversations', {}, authHeader);
    assert.equal(created.status, 201);
    const convId = created.json['id'] as string;
    assert.equal(typeof convId, 'string');

    const sse = watchSse(port, `/api/conversations/${convId}/stream?token=${AUTH_TOKEN}`, 'turn:done');

    const sent = await jsonRequest(port, 'POST', `/api/conversations/${convId}/message`, { text: 'Hi' }, authHeader);
    assert.equal(sent.status, 200);
    assert.equal(sent.json['ok'], true);
    assert.equal(typeof sent.json['turnId'], 'number');

    const streamed = await sse.seen;
    sse.stop();
    assert.match(streamed, /event: turn:start/);
    assert.match(streamed, /event: turn:text/);
    assert.match(streamed, /event: turn:done/);

    // Verify persistence via the HTTP API...
    const messages = await jsonRequest(port, 'GET', `/api/conversations/${convId}/messages`, undefined, authHeader);
    assert.equal(messages.status, 200);
    const rows = messages.json['messages'] as Array<{ role: string; content: unknown }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.role, 'user');
    assert.equal(rows[1]?.role, 'assistant');

    // ...and directly against the SQLite db passed into buildApp, since the
    // API layer reads through the same db.ts functions — this confirms the
    // turn actually landed in SQLite, not just in some in-process cache.
    const dbRows = getMessages(db, convId);
    assert.equal(dbRows.length, 2);
    const assistantContent = JSON.stringify(dbRows[1]?.content);
    assert.match(assistantContent, new RegExp(FAKE_REPLY_TEXT));

    // Auto-titling (C1): first exchange should have renamed the conversation.
    const conv = await jsonRequest(port, 'GET', `/api/conversations/${convId}`, undefined, authHeader);
    assert.equal(conv.json['title'], 'Hi');
  });
});
