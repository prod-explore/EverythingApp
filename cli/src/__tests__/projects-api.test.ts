import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp, type BuiltApp } from '../server.js';
import { openDb, runMigrations } from '../db.js';
import { ProviderRouter } from '../providers/router.js';

const TOKEN = 'test-token';

function req(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

describe('projects + conversations API', () => {
  let built: BuiltApp;
  let server: http.Server;
  let port: number;
  let db: ReturnType<typeof openDb>;

  before(async () => {
    db = openDb(':memory:');
    runMigrations(db);
    const router = new ProviderRouter({ db, env: {} as NodeJS.ProcessEnv, fetchImpl: (async () => new Response('{}')) as typeof fetch });
    built = await buildApp({ db, connections: [], router, authToken: TOKEN, config: { model: 'claude-sonnet-5', autoApproveTools: [], webSearchEnabled: false } });
    server = built.app.listen(0);
    port = (server.address() as AddressInfo).port;
  });
  after(() => {
    built.stop();
    server.close();
    db.close();
  });

  it('creates a conversation inside a project and lists it with its projectId', async () => {
    const project = (await req(port, 'POST', '/api/projects', { name: 'Alpha' })).json;
    const created = await req(port, 'POST', '/api/conversations', { title: 'in project', projectId: project.id });
    assert.equal(created.status, 201);

    const list = (await req(port, 'GET', '/api/conversations')).json.conversations as Array<{ id: string; projectId: string | null }>;
    assert.equal(list.find(c => c.id === created.json.id)?.projectId, project.id);

    const projects = (await req(port, 'GET', '/api/projects')).json.projects as Array<{ id: string; conversationCount: number }>;
    assert.equal(projects.find(p => p.id === project.id)?.conversationCount, 1);
  });

  it('rejects an unknown projectId instead of failing on the foreign key', async () => {
    const res = await req(port, 'POST', '/api/conversations', { title: 'x', projectId: 'does-not-exist' });
    assert.equal(res.status, 400);
  });

  it('a conversation without projectId stays a quick chat', async () => {
    const created = await req(port, 'POST', '/api/conversations', { title: 'quick' });
    const list = (await req(port, 'GET', '/api/conversations')).json.conversations as Array<{ id: string; projectId: string | null }>;
    assert.equal(list.find(c => c.id === created.json.id)?.projectId, null);
  });
});
