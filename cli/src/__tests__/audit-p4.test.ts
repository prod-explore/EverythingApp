import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as Llm from '../llm-types.js';
import { buildApp, type BuiltApp } from '../server.js';
import { openDb, runMigrations, setSetting } from '../db.js';
import { summarizeHistory } from '../context.js';
import { SSEManager } from '../sse.js';
import type { LlmClient } from '../llm-loop.js';

const TOKEN = 'p4-token';
const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-artifacts-'));
process.env['EVERYTHINGAPP_ARTIFACTS_DIR'] = artifactsDir;

function raw(port: number, method: string, p: string, body?: Buffer | string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const buf = body === undefined ? undefined : Buffer.from(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { authorization: `Bearer ${TOKEN}`, ...(buf ? { 'content-length': String(buf.length) } : {}), ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    if (buf) r.write(buf);
    r.end();
  });
}

describe('HTTP surface (audit N3, N4, N5, N7, N10)', () => {
  let built: BuiltApp; let server: http.Server; let port: number; let db: ReturnType<typeof openDb>;
  before(async () => {
    db = openDb(':memory:'); runMigrations(db);
    built = await buildApp({ db, connections: [], authToken: TOKEN, password: 'correct horse', config: { model: '@test/model-a', autoApproveTools: [] } });
    server = built.app.listen(0); port = (server.address() as AddressInfo).port;
  });
  after(() => { built.stop(); server.close(); db.close(); fs.rmSync(artifactsDir, { recursive: true, force: true }); });

  it('N3: only the settings the UI edits can be written or read through /api/settings', async () => {
    setSetting(db, 'vapid_public', 'SHOULD-NOT-LEAK');
    assert.equal((await raw(port, 'PUT', '/api/settings', JSON.stringify({ key: 'custom_instructions', value: 'be brief' }), { 'content-type': 'application/json' })).status, 200);
    for (const key of ['web_search', 'vapid_public', 'last_digest_date', 'anything']) {
      const r = await raw(port, 'PUT', '/api/settings', JSON.stringify({ key, value: 'x' }), { 'content-type': 'application/json' });
      assert.equal(r.status, 400, key);
    }
    const got = JSON.parse((await raw(port, 'GET', '/api/settings')).body).settings;
    assert.equal(got.custom_instructions, 'be brief');
    assert.ok(Object.keys(got).every(k => ['global_system_prompt', 'custom_instructions'].includes(k)), `only the editable keys: ${Object.keys(got)}`);
    assert.ok(!('vapid_public' in got));
  });

  it('N4: a JSON file uploaded to /api/artifacts keeps its bytes', async () => {
    const payload = JSON.stringify({ hello: 'world', n: [1, 2, 3] });
    const r = await raw(port, 'POST', '/api/artifacts?filename=data.json', payload, { 'content-type': 'application/json' });
    assert.equal(r.status, 201);
    const art = JSON.parse(r.body);
    assert.equal(art.sizeBytes, Buffer.byteLength(payload));
    const file = await raw(port, 'GET', `/api/artifacts/${art.id}/file`);
    assert.equal(file.body, payload);
  });

  it('N5: login accepts the password and refuses others, including ones of the same or a different length', async () => {
    const login = (password: string) => raw(port, 'POST', '/api/login', JSON.stringify({ password }), { 'content-type': 'application/json', authorization: '' });
    assert.equal((await login('correct horse')).status, 200);
    assert.equal((await login('correct horsf')).status, 401);
    assert.equal((await login('x')).status, 401);
    assert.equal((await login('correct horse and more')).status, 401);
  });

  it('N7: /health says the process is up and nothing else', async () => {
    const r = await raw(port, 'GET', '/health', undefined, { authorization: '' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { status: 'ok' });
  });

  it('N10: an unknown API path is a JSON 404, a missing asset a plain 404', async () => {
    const api = await raw(port, 'GET', '/api/no-such-thing');
    assert.equal(api.status, 404);
    assert.deepEqual(JSON.parse(api.body), { error: 'not found' });
    assert.equal((await raw(port, 'GET', '/assets/missing-abc123.js', undefined, { authorization: '' })).status, 404);
  });
});

describe('SSE backpressure (audit N8)', () => {
  it('drops a client whose buffer keeps growing, keeps a healthy one', () => {
    const sse = new SSEManager();
    const make = (backlog: number) => {
      const res = {
        written: 0, destroyed: false, writableLength: backlog,
        setHeader() {}, flushHeaders() {}, write() { this.written++; return true; }, on() {}, destroy() { this.destroyed = true; },
      };
      return res;
    };
    const slow = make(5 * 1024 * 1024); const fine = make(100);
    sse.addClient('c', slow as never);
    sse.addClient('c', fine as never);
    sse.emit('c', 'turn:text', { text: 'hi' });
    assert.equal(slow.destroyed, true);
    assert.equal(fine.destroyed, false);
    sse.emit('c', 'turn:text', { text: 'again' });
    assert.equal(slow.written, 2, 'the dropped client got nothing after the drop (initial comment + first event)');
    assert.equal(fine.written, 3);
  });
});

describe('summaries cut off by the output limit (audit N9)', () => {
  const reply = (t: string, stop: Llm.StopReason): Llm.Message => ({
    id: 'm', container: null, content: [{ type: 'text', text: t, citations: null }], model: 'x', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message',
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null },
  }) as unknown as Llm.Message;
  const messages: Llm.MessageParam[] = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }];

  it('asks again with twice the room and uses the complete answer', async () => {
    const budgets: number[] = [];
    const llm = { messages: { async create(p: Llm.MessageCreateParamsNonStreaming) { budgets.push(p.max_tokens); return budgets.length === 1 ? reply('The user said hel', 'max_tokens') : reply('Complete summary.', 'end_turn'); } } } as unknown as LlmClient;
    assert.equal(await summarizeHistory({ llm, model: 'm', messages }), 'Complete summary.');
    assert.deepEqual(budgets, [2000, 4000]);
  });

  it('refuses a summary that is still cut off', async () => {
    const llm = { messages: { async create() { return reply('cut', 'max_tokens'); } } } as unknown as LlmClient;
    await assert.rejects(summarizeHistory({ llm, model: 'm', messages }), /cut off/);
  });
});
