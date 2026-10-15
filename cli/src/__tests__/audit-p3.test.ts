import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as Llm from '../llm-types.js';
import { buildApp, type BuiltApp } from '../server.js';
import { WebApprovalGate } from '../web-approval.js';
import { attachSkill, createSkill, getAllMessagesFull, openDb, runMigrations } from '../db.js';
import type { McpConnectionLike } from '../mcp-client.js';

const TOKEN = 'p3-token';

function msg(content: Llm.ContentBlock[], stop: Llm.StopReason): Llm.Message {
  return {
    id: 'm', container: null, content, model: '@test/model-a', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message',
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null },
  } as unknown as Llm.Message;
}
const use = (id: string): Llm.ContentBlock => ({ type: 'tool_use', id, name: 'notes__write_note', input: { path: 'a.md' } }) as unknown as Llm.ContentBlock;
const text = (t: string): Llm.ContentBlock => ({ type: 'text', text: t, citations: null }) as unknown as Llm.ContentBlock;

function connection(calls: string[]): McpConnectionLike {
  return {
    name: 'notes',
    async listTools() { return [{ name: 'write_note', description: 'write', inputSchema: { type: 'object' } }]; },
    async callTool(name) { calls.push(name); return { text: 'listing', isError: false }; },
  };
}

function client(port: number) {
  return (method: string, path: string, body?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
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

async function settled(call: ReturnType<typeof client>, convId: string, ms = 3000): Promise<string> {
  for (let t = 0; t < ms; t += 25) {
    const s = (await call('GET', `/api/conversations/${convId}/status`)).json;
    if (s.status && s.status !== 'running' && s.status !== 'idle') return s.status;
    await new Promise(r => setTimeout(r, 25));
  }
  return 'timeout';
}

// ─── S4 ──────────────────────────────────────────────────────────────────────

describe('skill grants end with the turn (audit S4)', () => {
  it('WebApprovalGate: clearChatScope takes the grants back', async () => {
    const db = openDb(':memory:'); runMigrations(db);
    const gate = new WebApprovalGate(db);
    gate.grantChatScope('c', 'sandbox__run_bash');
    assert.equal(await gate.confirm('c', 'sandbox__run_bash', {}), true);
    gate.clearChatScope('c');
    const parked = gate.confirm('c', 'sandbox__run_bash', {});
    assert.equal(gate.listPending().length, 1, 'asks again');
    gate.resolve(gate.listPending()[0]!.id, false, 'once');
    assert.equal(await parked, false);
    db.close();
  });

  describe('end to end', () => {
    let built: BuiltApp; let server: http.Server; let db: ReturnType<typeof openDb>; let call: ReturnType<typeof client>;
    const calls: string[] = [];
    let script: Array<Llm.Message | Error> = [];
    before(async () => {
      db = openDb(':memory:'); runMigrations(db);
      const llm = { messages: { async create() { const s = script.shift(); if (!s) throw new Error('script exhausted'); if (s instanceof Error) throw s; return s; }, batches: {} } };
      // (a shell tool would not do: tool-level grants deliberately do not apply to run_bash)
      // the tool is NOT in autoApproveTools: only a skill's allowedTools can let it through unasked
      built = await buildApp({ db, connections: [connection(calls)] as never, llm: llm as never, authToken: TOKEN, config: { model: '@test/model-a', autoApproveTools: [] } });
      server = built.app.listen(0); call = client((server.address() as AddressInfo).port);
    });
    after(() => { built.stop(); server.close(); db.close(); });

    it('lets the tool through while the skill is attached, and asks again once it is detached', async () => {
      const { id } = (await call('POST', '/api/conversations', {})).json;
      const skill = createSkill(db, { name: 's', prompt: 'p', allowedTools: ['notes/write_note'] });
      attachSkill(db, id, skill.id);

      script = [msg([use('a')], 'tool_use'), msg([text('done')], 'end_turn')];
      await call('POST', `/api/conversations/${id}/message`, { text: 'one' });
      assert.equal(await settled(call, id), 'done');
      assert.deepEqual(calls, ['write_note'], 'ran without a prompt');

      assert.equal((await call('DELETE', `/api/conversations/${id}/skills/${skill.id}`)).status, 200);
      script = [msg([use('b')], 'tool_use'), msg([text('done')], 'end_turn')];
      await call('POST', `/api/conversations/${id}/message`, { text: 'two' });
      let pending = 0;
      for (let i = 0; i < 100 && pending === 0; i++) { pending = (await call('GET', '/api/pending-approvals')).json.pending.length; await new Promise(r => setTimeout(r, 20)); }
      assert.equal(pending, 1, 'the grant did not outlive the skill');
      assert.deepEqual(calls, ['write_note'], 'not run yet');
      await call('POST', `/api/conversations/${id}/kill`);
    });
  });
});

// ─── N1 ──────────────────────────────────────────────────────────────────────

describe('a failure while preparing a turn ends the turn (audit N1)', () => {
  it('reports an error and leaves the conversation usable instead of "running" forever', async () => {
    const db = openDb(':memory:'); runMigrations(db);
    const llm = { messages: { async create() { return msg([text('hi')], 'end_turn'); }, batches: {} } };
    const built = await buildApp({ db, connections: [], llm: llm as never, authToken: TOKEN, config: { model: '@test/model-a', autoApproveTools: [] } });
    const server = built.app.listen(0);
    const call = client((server.address() as AddressInfo).port);
    const { id } = (await call('POST', '/api/conversations', {})).json;

    // Make the first preparation step (creating the run row) fail once.
    db.exec('ALTER TABLE runs RENAME TO runs_off');
    try {
      assert.equal((await call('POST', `/api/conversations/${id}/message`, { text: 'one' })).status, 200);
      assert.equal(await settled(call, id), 'error');
    } finally {
      db.exec('ALTER TABLE runs_off RENAME TO runs');
    }
    // not stuck: the next message is accepted and completes
    assert.equal((await call('POST', `/api/conversations/${id}/message`, { text: 'two' })).status, 200);
    assert.equal(await settled(call, id), 'done');
    assert.ok(getAllMessagesFull(db, id).length >= 3);
    built.stop(); server.close(); db.close();
  });
});

// ─── N2 ──────────────────────────────────────────────────────────────────────

describe('/compact holds the conversation while the model writes the summary (audit N2)', () => {
  it('refuses a message sent meanwhile', async () => {
    const db = openDb(':memory:'); runMigrations(db);
    let release: (() => void) | undefined;
    let summarising = false;
    const llm = {
      messages: {
        async create() {
          summarising = true;
          await new Promise<void>(r => { release = r; });
          return msg([text('a summary')], 'end_turn');
        },
        batches: {},
      },
    };
    const built = await buildApp({ db, connections: [], llm: llm as never, authToken: TOKEN, config: { model: '@test/model-a', autoApproveTools: [] } });
    const server = built.app.listen(0);
    const call = client((server.address() as AddressInfo).port);
    const { id } = (await call('POST', '/api/conversations', {})).json;
    for (let i = 0; i < 6; i++) {
      db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run(id, i % 2 ? 'assistant' : 'user', JSON.stringify(i % 2 ? [{ type: 'text', text: `a${i}` }] : `q${i}`));
    }

    const compacting = call('POST', `/api/conversations/${id}/compact`);
    for (let i = 0; i < 100 && !summarising; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(summarising, true, 'the summary request is in flight');
    assert.equal((await call('POST', `/api/conversations/${id}/message`, { text: 'meanwhile' })).status, 409);
    assert.equal((await call('POST', `/api/conversations/${id}/compact`)).status, 409, 'and a second compaction too');

    release?.();
    assert.equal((await compacting).status, 200);
    assert.notEqual((await call('POST', `/api/conversations/${id}/message`, { text: 'after' })).status, 409, 'released afterwards');
    built.stop(); server.close(); db.close();
  });
});
