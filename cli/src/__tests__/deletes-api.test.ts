import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp, type BuiltApp } from '../server.js';
import { appendMessage, openDb, runMigrations } from '../db.js';
import { ProviderRouter } from '../providers/router.js';

const TOKEN = 'test-token';
function req(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

describe('deleting messages, conversations and projects', () => {
  let built: BuiltApp; let server: http.Server; let port: number; let db: ReturnType<typeof openDb>;
  before(async () => {
    db = openDb(':memory:'); runMigrations(db);
    const router = new ProviderRouter({ db, env: {} as NodeJS.ProcessEnv, fetchImpl: (async () => new Response('{}')) as typeof fetch });
    built = await buildApp({ db, connections: [], router, authToken: TOKEN, config: { model: 'claude-sonnet-5', autoApproveTools: [], webSearchEnabled: false } });
    server = built.app.listen(0); port = (server.address() as AddressInfo).port;
  });
  after(() => { built.stop(); server.close(); db.close(); });

  it('deletes a message and everything after it', async () => {
    const { id } = (await req(port, 'POST', '/api/conversations', { title: 'c' })).json;
    const m1 = appendMessage(db, id, 'user', 'one');
    appendMessage(db, id, 'assistant', 'two');
    appendMessage(db, id, 'user', 'three');
    const res = await req(port, 'DELETE', `/api/conversations/${id}/messages/${m1 + 1}`);
    assert.equal(res.status, 200);
    const left = (await req(port, 'GET', `/api/conversations/${id}/messages`)).json.messages;
    assert.equal(left.length, 1);
  });

  it('deletes a conversation with its messages', async () => {
    const { id } = (await req(port, 'POST', '/api/conversations', { title: 'c' })).json;
    appendMessage(db, id, 'user', 'x');
    assert.equal((await req(port, 'DELETE', `/api/conversations/${id}`)).status, 200);
    assert.equal((await req(port, 'GET', `/api/conversations/${id}`)).status, 404);
  });

  it('deleting a project deletes its chats by default; ?conversations=keep detaches them', async () => {
    const p1 = (await req(port, 'POST', '/api/projects', { name: 'A' })).json.id;
    const c1 = (await req(port, 'POST', '/api/conversations', { title: 'a1', projectId: p1 })).json.id;
    assert.equal((await req(port, 'DELETE', `/api/projects/${p1}`)).status, 200);
    assert.equal((await req(port, 'GET', `/api/conversations/${c1}`)).status, 404);

    const p2 = (await req(port, 'POST', '/api/projects', { name: 'B' })).json.id;
    const c2 = (await req(port, 'POST', '/api/conversations', { title: 'b1', projectId: p2 })).json.id;
    assert.equal((await req(port, 'DELETE', `/api/projects/${p2}?conversations=keep`)).status, 200);
    const kept = await req(port, 'GET', `/api/conversations/${c2}`);
    assert.equal(kept.status, 200);
    assert.equal(kept.json.projectId, null);
  });

  it('refuses to delete a conversation or project while a turn is running', async () => {
    assert.equal((await req(port, 'DELETE', '/api/conversations/nope')).status, 404);
    assert.equal((await req(port, 'DELETE', '/api/projects/nope')).status, 404);
  });
});
