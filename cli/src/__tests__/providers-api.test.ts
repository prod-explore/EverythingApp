import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp, type BuiltApp } from '../server.js';
import { openDb, runMigrations, createConversation } from '../db.js';
import { ProviderRouter } from '../providers/router.js';

const TOKEN = 'test-token';
const SECRET = 'z'.repeat(48);
const KEY = 'mg-super-secret-gateway-key-9999';

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

/** A gateway that lists models (with MindGate-style extensions) and accepts exactly one key. */
const GATEWAY_MODELS = {
  data: [
    { id: 'flash', kind: 'chat', tags: ['free'], description: 'Fast and free', supports: ['tools'] },
    { id: 'big', kind: 'chat', tags: ['reasoning', 'coder'], pricing: { input: 3, output: 15 } },
    { id: 'whisper', kind: 'stt' },
  ],
};

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
  const calls: string[] = [];

  before(async () => {
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      const ok = (init?.headers as Record<string, string>)['Authorization'] === `Bearer ${KEY}`;
      return new Response(ok ? JSON.stringify(GATEWAY_MODELS) : 'bad key', { status: ok ? 200 : 401 });
    }) as typeof fetch;
    const b = boot(SECRET, fetchImpl);
    db = b.db;
    built = await buildApp({ db, connections: [], router: b.router, authToken: TOKEN, config: { model: '', autoApproveTools: [] } });
    server = built.app.listen(0);
    port = (server.address() as AddressInfo).port;
  });
  after(() => {
    built.stop();
    server.close();
    db.close();
  });

  it('starts empty: no built-in providers, the user adds every one', async () => {
    const r = await req(port, 'GET', '/api/providers');
    assert.equal(r.status, 200);
    assert.equal(r.json.vaultEnabled, true);
    assert.deepEqual(r.json.providers, []);
    assert.equal('presets' in r.json, false);
    assert.deepEqual((await req(port, 'GET', '/api/models')).json.models, []);
  });

  it('adds a provider: saves the key, discovers models, never returns the key', async () => {
    const r = await req(port, 'POST', '/api/providers', { slug: 'mindgate', label: 'MindGate', baseUrl: 'https://hub.example/v1', apiKey: KEY });
    assert.equal(r.status, 201);
    assert.equal(r.json.refresh.ok, true);
    assert.equal(r.json.refresh.count, 3);
    assert.ok(calls.at(-1)!.endsWith('/models'));

    const list = (await req(port, 'GET', '/api/providers')).json.providers;
    const mg = list.find((p: any) => p.id === 'mindgate');
    assert.deepEqual([mg.configured, mg.source, mg.last4, mg.modelCount, mg.enabledModelCount, mg.concurrency, mg.retryMin, 'flavor' in mg], [true, 'vault', '9999', 3, 3, null, null, false]);
    for (const path of ['/api/providers', '/api/settings', '/api/models', '/api/providers/mindgate/models']) {
      assert.ok(!JSON.stringify((await req(port, 'GET', path)).json).includes('super-secret'), `${path} leaked the key`);
    }
  });

  it('the discovered models carry kind and tags; pickers filter on kind', async () => {
    const models = (await req(port, 'GET', '/api/models')).json.models;
    const flash = models.find((m: any) => m.id === '@mindgate/flash');
    assert.deepEqual([flash.kind, flash.tags, flash.available, flash.providerLabel], ['chat', ['free'], true, 'MindGate']);
    assert.equal(models.find((m: any) => m.id === '@mindgate/whisper').kind, 'stt');
    const big = models.find((m: any) => m.id === '@mindgate/big');
    assert.ok(!('pricing' in big) && !('pricingKnown' in big), 'the app exposes no prices');
  });

  it('a provider starts with the same defaults as every other and takes retry and concurrency as plain settings', async () => {
    assert.equal((await req(port, 'POST', '/api/providers', { slug: 'plain', baseUrl: 'https://plain.example/v1', keyOptional: true, retryMin: 30 })).status, 201);
    const get = async () => (await req(port, 'GET', '/api/providers')).json.providers.find((p: any) => p.id === 'plain');
    assert.deepEqual([(await get()).concurrency, (await get()).retryMin], [null, 30]);
    assert.equal((await req(port, 'PATCH', '/api/providers/plain', { concurrency: 0 })).status, 400);
    assert.equal((await req(port, 'PATCH', '/api/providers/plain', { concurrency: 1 })).status, 200);
    assert.equal((await get()).concurrency, 1);
    await req(port, 'DELETE', '/api/providers/plain');
  });

  it('a plain API is added through the very same call', async () => {
    const r = await req(port, 'POST', '/api/providers', { slug: 'lan', label: 'LAN box', baseUrl: 'http://192.168.1.20:1234/v1', keyOptional: true });
    assert.equal(r.status, 201);
    const add = await req(port, 'POST', '/api/providers/lan/models', { id: 'qwen', tags: ['free', 'coder'] });
    assert.deepEqual([add.status, add.json.id], [201, '@lan/qwen']);
    assert.equal((await req(port, 'POST', '/api/providers/lan/models', { id: 'qwen' })).status, 409);
    const qwen = (await req(port, 'GET', '/api/models')).json.models.find((m: any) => m.id === '@lan/qwen');
    assert.deepEqual([qwen.tags, qwen.available], [['free', 'coder'], true]);
  });

  it('validates providers', async () => {
    assert.equal((await req(port, 'POST', '/api/providers', { slug: 'Bad Slug', baseUrl: 'https://x.example' })).status, 400);
    assert.equal((await req(port, 'POST', '/api/providers', { slug: 'cred', baseUrl: 'https://user:pw@x.example' })).status, 400);
    assert.equal((await req(port, 'POST', '/api/providers', { slug: 'mindgate', baseUrl: 'https://x.example' })).status, 409);
    assert.equal((await req(port, 'PUT', '/api/providers/mindgate/key', { key: 'has space in it' })).status, 400);
    assert.equal((await req(port, 'PUT', '/api/providers/nope/key', { key: 'abcdefghij' })).status, 404);
  });

  it('the busy-retry window is a plain per-provider setting: validated and clearable', async () => {
    const get = async () => (await req(port, 'GET', '/api/providers')).json.providers.find((p: any) => p.id === 'mindgate');
    assert.equal((await get()).retryMin, null, 'the mindgate dialect has no default');
    assert.equal((await req(port, 'PATCH', '/api/providers/mindgate', { retryMin: 0.5 })).status, 400);
    assert.equal((await req(port, 'PATCH', '/api/providers/mindgate', { retryMin: 90 })).status, 200);
    assert.equal((await get()).retryMin, 90);
    assert.equal((await req(port, 'PATCH', '/api/providers/mindgate', { retryMin: null })).status, 200);
    assert.equal((await get()).retryMin, null, 'null = back to the default');
  });

  it('edits a model: switch off, override tags, and clear the override again', async () => {
    const id = '@mindgate/big';
    assert.equal((await req(port, 'PATCH', '/api/models', { id, tags: ['coder'], description: 'mine' })).status, 200);
    let m = (await req(port, 'GET', '/api/providers/mindgate/models')).json.models.find((x: any) => x.id === id);
    assert.deepEqual([m.tags, m.description], [['coder'], 'mine']);
    await req(port, 'PATCH', '/api/models', { id, tags: null });
    m = (await req(port, 'GET', '/api/providers/mindgate/models')).json.models.find((x: any) => x.id === id);
    assert.deepEqual(m.tags, ['reasoning', 'coder']);
    await req(port, 'PATCH', '/api/models', { id, enabled: false });
    assert.ok(!(await req(port, 'GET', '/api/models')).json.models.some((x: any) => x.id === id), 'disabled models leave the pickers');
    assert.equal((await req(port, 'PATCH', '/api/models', { id: '@mindgate/ghost', enabled: false })).status, 404);
    await req(port, 'PATCH', '/api/models', { id, enabled: true });
  });

  it('a conversation cannot be put on a known non-chat or tool-less model', async () => {
    await req(port, 'POST', '/api/providers/lan/models', { id: 'notools', toolSchemaMode: 'none' });
    const bad = await req(port, 'POST', '/api/conversations', { model: '@mindgate/whisper' });
    assert.equal(bad.status, 400);
    assert.equal((await req(port, 'POST', '/api/conversations', { model: '@lan/notools' })).status, 400, 'no tool calls = not a chat model for this app');
    const conv = (await req(port, 'POST', '/api/conversations', {})).json.id;
    assert.equal((await req(port, 'PATCH', `/api/conversations/${conv}`, { model: '@mindgate/whisper' })).status, 400);
    assert.equal((await req(port, 'PATCH', `/api/conversations/${conv}`, { model: '@lan/notools' })).status, 400);
    assert.equal((await req(port, 'PATCH', `/api/conversations/${conv}`, { model: '@mindgate/flash' })).status, 200);
    assert.equal((await req(port, 'GET', `/api/conversations/${conv}`)).json.model, '@mindgate/flash');
    assert.equal((await req(port, 'PATCH', `/api/conversations/${conv}`, { model: '@gone/unlisted-model' })).status, 200, 'unknown ids are tolerated; the turn reports them');
    const pick = (await req(port, 'GET', '/api/models')).json.models.find((m: any) => m.id === '@lan/notools');
    assert.equal(pick.toolSchemaMode, 'none', 'pickers get the flag and hide such models');
  });

  it('slots: unset ones resolve automatically, explicit ones must be real chat models', async () => {
    const s = (await req(port, 'GET', '/api/slots')).json;
    assert.equal(s.slots.helper, '');
    assert.equal(s.resolved.helper, '@mindgate/flash'); // first free chat model
    assert.equal(s.resolved.escalation, null);          // never automatic
    assert.equal(s.allowPaidAgents, false);

    assert.equal((await req(port, 'PUT', '/api/slots', { chat: '@mindgate/whisper' })).status, 400); // not a chat model
    assert.equal((await req(port, 'PUT', '/api/slots', { chat: '@nope/x' })).status, 400);
    const ok = await req(port, 'PUT', '/api/slots', { chat: '@mindgate/big', escalation: '@mindgate/big', allowPaidAgents: true });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.json.resolved.chat, ok.json.resolved.escalation, ok.json.allowPaidAgents], ['@mindgate/big', '@mindgate/big', true]);
    assert.equal((await req(port, 'PUT', '/api/slots', { allowPaidAgents: 'yes' })).status, 400);
    await req(port, 'PUT', '/api/slots', { chat: '', escalation: '', allowPaidAgents: false });
  });

  it('a bad key is saved but reported as unverified; removing a key makes the provider unusable', async () => {
    const bad = await req(port, 'PUT', '/api/providers/lan/key', { key: 'sk-wrong-key-0000' });
    assert.equal(bad.json.ok, true);
    await req(port, 'DELETE', '/api/providers/lan/key');
    const t = await req(port, 'POST', '/api/providers/mindgate/test');
    assert.equal(t.json.ok, true);
    await req(port, 'DELETE', '/api/providers/mindgate/key');
    assert.equal((await req(port, 'GET', '/api/providers')).json.providers.find((p: any) => p.id === 'mindgate').configured, false);
    const m = (await req(port, 'GET', '/api/models')).json.models.find((x: any) => x.id === '@mindgate/flash');
    assert.equal(m.available, false);
  });

  it('a turn on a provider without a key fails with a clear turn error, not a crash', async () => {
    const convId = createConversation(db, { model: '@mindgate/flash' }).id;
    const sent = await req(port, 'POST', `/api/conversations/${convId}/message`, { content: 'hi' });
    assert.equal(sent.status, 200);
    await new Promise(r => setTimeout(r, 100));
    const status = await req(port, 'GET', `/api/conversations/${convId}/status`);
    assert.equal(status.json.status, 'error');
    assert.match(status.json.error, /No MindGate API key configured/);
  });

  it('deleting a provider removes its models', async () => {
    assert.equal((await req(port, 'DELETE', '/api/providers/lan')).json.ok, true);
    assert.ok(!(await req(port, 'GET', '/api/models')).json.models.some((m: any) => m.provider === 'lan'));
    assert.equal((await req(port, 'DELETE', '/api/providers/lan')).status, 404);
  });

  it('serves the usage report and validates its range', async () => {
    const ok = await req(port, 'GET', '/api/usage/report?range=7d&tzOffset=120');
    assert.equal(ok.status, 200);
    assert.ok('totals' in ok.json && Array.isArray(ok.json.byDay));
    assert.ok(!JSON.stringify(ok.json).match(/cost|pric/i), 'tokens only');
    assert.equal((await req(port, 'GET', '/api/usage/report?range=forever')).status, 400);
  });
});

describe('providers API with the vault disabled', () => {
  it('refuses to store keys and says why', async () => {
    const { db, router } = boot(undefined, fetch);
    const built = await buildApp({ db, connections: [], router, authToken: TOKEN, config: { model: '', autoApproveTools: [] } });
    const server = built.app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const r = await req(port, 'POST', '/api/providers', { slug: 'gemini', baseUrl: 'https://api.example/v1', apiKey: 'AIzaSy-something-long' });
      assert.equal(r.status, 503);
      assert.match(r.json.error, /KEY_VAULT_SECRET/);
    } finally {
      built.stop();
      server.close();
      db.close();
    }
  });
});
