import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp, type BuiltApp } from '../server.js';
import { openDb, runMigrations, createConversation } from '../db.js';
import { ProviderRouter } from '../providers/router.js';

const TOKEN = 'test-token';
const SECRET = 'z'.repeat(48);
const GEMINI_KEY = 'AIzaSy-super-secret-gemini-key-9999';

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

function boot(secret: string | undefined, fetchImpl: typeof fetch) {
  const db = openDb(':memory:');
  runMigrations(db);
  const router = new ProviderRouter({ db, env: { KEY_VAULT_SECRET: secret } as NodeJS.ProcessEnv, fetchImpl });
  return { db, router };
}

describe('providers API', () => {
  let built: BuiltApp;
  let server: http.Server;
  let port: number;
  let db: ReturnType<typeof openDb>;
  const geminiCalls: string[] = [];

  before(async () => {
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      geminiCalls.push(String(url));
      const ok = (init?.headers as Record<string, string>)['Authorization'] === `Bearer ${GEMINI_KEY}`;
      return new Response(ok ? '{"data":[]}' : 'bad key', { status: ok ? 200 : 401 });
    }) as typeof fetch;
    const b = boot(SECRET, fetchImpl);
    db = b.db;
    built = await buildApp({ db, connections: [], router: b.router, authToken: TOKEN, config: { model: 'claude-sonnet-5', autoApproveTools: [], webSearchEnabled: false } });
    server = built.app.listen(0);
    port = (server.address() as AddressInfo).port;
  });
  after(() => {
    built.stop();
    server.close();
    db.close();
  });

  it('starts with nothing configured', async () => {
    const r = await req(port, 'GET', '/api/providers');
    assert.equal(r.status, 200);
    assert.equal(r.json.vaultEnabled, true);
    assert.ok(r.json.providers.every((p: any) => p.configured === false));
  });

  it('saves a key, verifies it, and never returns it', async () => {
    const put = await req(port, 'PUT', '/api/providers/gemini/key', { key: GEMINI_KEY });
    assert.deepEqual([put.status, put.json.ok, put.json.verified], [200, true, true]);
    assert.ok(geminiCalls[0]!.endsWith('/models'));

    const list = await req(port, 'GET', '/api/providers');
    const g = list.json.providers.find((p: any) => p.id === 'gemini');
    assert.deepEqual([g.configured, g.source, g.last4], [true, 'vault', '9999']);
    for (const path of ['/api/providers', '/api/settings', '/api/models']) {
      assert.ok(!JSON.stringify((await req(port, 'GET', path)).json).includes('super-secret'), `${path} leaked the key`);
    }
    assert.equal((await req(port, 'GET', '/api/models')).json.models.find((m: any) => m.id === 'gemini-3.8-flash').available, true);
    assert.equal((await req(port, 'GET', '/api/models')).json.models.find((m: any) => m.id === 'deepseek-chat').available, false);
  });

  it('reports a bad key as saved-but-unverified', async () => {
    const r = await req(port, 'PUT', '/api/providers/deepseek/key', { key: 'sk-wrong-key-0000' });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.verified, false);
  });

  it('validates input and unknown providers', async () => {
    assert.equal((await req(port, 'PUT', '/api/providers/gemini/key', { key: 'has space in it' })).status, 400);
    assert.equal((await req(port, 'PUT', '/api/providers/nope/key', { key: 'abcdefghij' })).status, 404);
    assert.equal((await req(port, 'PUT', '/api/providers/gemini/limits', { warnUsdMonthly: -3 })).status, 400);
    assert.equal((await req(port, 'PUT', '/api/providers/gemini/limits', { warnUsdMonthly: 20 })).status, 200);
    assert.equal((await req(port, 'GET', '/api/providers')).json.providers.find((p: any) => p.id === 'gemini').warnUsdMonthly, 20);
  });

  it('removes keys', async () => {
    assert.equal((await req(port, 'DELETE', '/api/providers/gemini/key')).json.ok, true);
    assert.equal((await req(port, 'GET', '/api/providers')).json.providers.find((p: any) => p.id === 'gemini').configured, false);
  });

  it('a turn on an unconfigured provider fails with a clear turn error, not a crash', async () => {
    const convId = createConversation(db, { model: 'deepseek-chat' }).id;
    // deepseek key was saved above but is wrong; remove it to test the missing-key path
    await req(port, 'DELETE', '/api/providers/deepseek/key');
    const sent = await req(port, 'POST', `/api/conversations/${convId}/message`, { content: 'hi' });
    assert.equal(sent.status, 200);
    await new Promise(r => setTimeout(r, 100));
    const status = await req(port, 'GET', `/api/conversations/${convId}/status`);
    assert.equal(status.json.status, 'error');
    assert.match(status.json.error, /No DeepSeek API key configured/);
  });

  it('refuses batch mode for non-Anthropic models', async () => {
    const convId = createConversation(db, { model: 'gemini-3.8-flash' }).id;
    await req(port, 'PUT', '/api/providers/gemini/key', { key: GEMINI_KEY, verify: false });
    const r = await req(port, 'POST', `/api/conversations/${convId}/message`, { content: 'hi', batch: true });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /only available for Anthropic/);
  });

  it('serves the usage report and validates its range', async () => {
    const ok = await req(port, 'GET', '/api/usage/report?range=7d&tzOffset=120');
    assert.equal(ok.status, 200);
    assert.ok('totals' in ok.json && Array.isArray(ok.json.byDay));
    assert.equal((await req(port, 'GET', '/api/usage/report?range=forever')).status, 400);
  });
});

describe('providers API with the vault disabled', () => {
  it('refuses to store keys and says why', async () => {
    const { db, router } = boot(undefined, fetch);
    const built = await buildApp({ db, connections: [], router, authToken: TOKEN, config: { model: 'claude-sonnet-5', autoApproveTools: [], webSearchEnabled: false } });
    const server = built.app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const r = await req(port, 'PUT', '/api/providers/gemini/key', { key: 'AIzaSy-something-long' });
      assert.equal(r.status, 503);
      assert.match(r.json.error, /KEY_VAULT_SECRET/);
    } finally {
      built.stop();
      server.close();
      db.close();
    }
  });
});
