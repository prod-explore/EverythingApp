import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as Llm from '../llm-types.js';
import { buildApp, type BuiltApp } from '../server.js';
import { appendMessage, findRegenerationAnchor, getAllMessagesFull, openDb, runMigrations } from '../db.js';
import { INTERRUPTED_TOOL_RESULT, runTurn, type LlmClient } from '../llm-loop.js';
import { ToolRegistry } from '../tool-registry.js';
import type { McpConnectionLike } from '../mcp-client.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function msg(content: Llm.ContentBlock[], stop: Llm.StopReason): Llm.Message {
  return {
    id: 'm', container: null, content, model: '@test/model-a', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message',
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null },
  } as unknown as Llm.Message;
}
const text = (t: string): Llm.ContentBlock => ({ type: 'text', text: t, citations: null }) as unknown as Llm.ContentBlock;
const use = (id: string, name = 'sandbox__run_bash'): Llm.ContentBlock => ({ type: 'tool_use', id, name, input: { command: 'ls' } }) as unknown as Llm.ContentBlock;

/** Each entry is a reply, or an Error to throw. */
function scripted(steps: Array<Llm.Message | Error>): LlmClient {
  let i = 0;
  return {
    messages: {
      async create() {
        const s = steps[i++];
        if (!s) throw new Error('script exhausted');
        if (s instanceof Error) throw s;
        return s;
      },
    },
  } as LlmClient;
}

function connection(calls: string[]): McpConnectionLike {
  return {
    name: 'sandbox',
    async listTools() { return [{ name: 'run_bash', description: 'run', inputSchema: { type: 'object' } }]; },
    async callTool(name) { calls.push(name); return { text: 'listing', isError: false }; },
  };
}

async function registry(calls: string[]): Promise<ToolRegistry> {
  const r = new ToolRegistry(['sandbox__run_bash']);
  await r.loadFrom([connection(calls)]);
  return r;
}

const resultsOf = (m: Llm.MessageParam): Llm.ToolResultBlockParam[] =>
  (m.content as Llm.ContentBlockParam[]).filter((b): b is Llm.ToolResultBlockParam => b.type === 'tool_result');

// ─── runTurn hands the turn over as it happens (audit W1) ────────────────────

describe('runTurn: onMessages', () => {
  it('hands over each step before the next request, and everything adds up to the returned history', async () => {
    const calls: string[] = [];
    const batches: Llm.MessageParam[][] = [];
    const seenAtRequest: number[] = [];
    let stored = 0;
    const base = scripted([msg([use('t1')], 'tool_use'), msg([text('done')], 'end_turn')]);
    const llm: LlmClient = { messages: { async create(p, o) { seenAtRequest.push(stored); return base.messages.create(p, o); } } } as LlmClient;

    const out = await runTurn(
      { llm, model: 'm', tools: await registry(calls), systemPrompt: 's', confirm: async () => true, onMessages: b => { batches.push(b); stored += b.length; } },
      [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
      'go',
    );

    assert.deepEqual(batches.map(b => b.map(m => m.role)), [['assistant', 'user'], ['assistant']]);
    assert.deepEqual(seenAtRequest, [0, 2], 'the first step is stored before the second request goes out');
    assert.deepEqual(batches.flat(), out.slice(3), 'history and the user message are not handed over again');
    assert.deepEqual(calls, ['run_bash']);
  });

  it('keeps text appended from the inbox in the stored tool-result message', async () => {
    const batches: Llm.MessageParam[][] = [];
    let step = 0;
    await runTurn(
      {
        llm: scripted([msg([use('t1')], 'tool_use'), msg([text('done')], 'end_turn')]), model: 'm', tools: await registry([]), systemPrompt: 's',
        confirm: async () => true, onMessages: b => batches.push(b),
        // a message from another agent arrives while the tool runs: it is merged before the second request
        drainInbox: () => (++step === 2 ? ['[message from agent]\nhello'] : []),
      },
      [],
      'go',
    );
    const carrier = batches[0]![1]!;
    assert.equal(carrier.role, 'user');
    assert.equal(resultsOf(carrier).length, 1);
    assert.match(JSON.stringify(carrier.content), /message from agent/);
  });

  it('a kill while a tool waits for approval stores the call with an "interrupted" result', async () => {
    const calls: string[] = [];
    const batches: Llm.MessageParam[][] = [];
    const controller = new AbortController();
    await assert.rejects(
      runTurn(
        {
          llm: scripted([msg([use('t1')], 'tool_use')]), model: 'm', tools: await registry(calls), systemPrompt: 's', signal: controller.signal,
          confirm: async () => { controller.abort(); return true; }, onMessages: b => batches.push(b),
        },
        [],
        'go',
      ),
      /kill switch/,
    );
    assert.deepEqual(calls, []);
    const stored = batches.flat();
    assert.deepEqual(stored.map(m => m.role), ['assistant', 'user']);
    const [r] = resultsOf(stored[1]!);
    assert.equal(r!.tool_use_id, 't1');
    assert.equal(r!.is_error, true);
    assert.equal(r!.content, INTERRUPTED_TOOL_RESULT);
  });

  it('closes only the calls that did not finish, keeping the results that did', async () => {
    const calls: string[] = [];
    const batches: Llm.MessageParam[][] = [];
    const controller = new AbortController();
    let asked = 0;
    await assert.rejects(
      runTurn(
        {
          llm: scripted([msg([use('t1'), use('t2'), use('t3')], 'tool_use')]), model: 'm', tools: await registry(calls), systemPrompt: 's', signal: controller.signal,
          confirm: async () => { if (++asked === 2) controller.abort(); return true; }, onMessages: b => batches.push(b),
        },
        [],
        'go',
      ),
      /kill switch/,
    );
    assert.deepEqual(calls, ['run_bash'], 'only the first call ran');
    const rs = resultsOf(batches.flat()[1]!);
    assert.deepEqual(rs.map(r => [r.tool_use_id, r.is_error === true]), [['t1', false], ['t2', true], ['t3', true]]);
  });

  it('a provider failure after a finished step keeps that step', async () => {
    const batches: Llm.MessageParam[][] = [];
    await assert.rejects(
      runTurn(
        { llm: scripted([msg([use('t1')], 'tool_use'), new Error('boom')]), model: 'm', tools: await registry([]), systemPrompt: 's', confirm: async () => true, onMessages: b => batches.push(b) },
        [],
        'go',
      ),
      /boom/,
    );
    assert.deepEqual(batches.flat().map(m => m.role), ['assistant', 'user']);
    assert.equal(resultsOf(batches.flat()[1]!)[0]!.is_error, false);
  });

  it('a failure on the very first request stores nothing', async () => {
    const batches: Llm.MessageParam[][] = [];
    await assert.rejects(
      runTurn({ llm: scripted([new Error('boom')]), model: 'm', tools: await registry([]), systemPrompt: 's', confirm: async () => true, onMessages: b => batches.push(b) }, [], 'go'),
      /boom/,
    );
    assert.deepEqual(batches, []);
  });

  it('reports the original failure when storing fails too', async () => {
    await assert.rejects(
      runTurn(
        { llm: scripted([msg([use('t1')], 'tool_use'), new Error('boom')]), model: 'm', tools: await registry([]), systemPrompt: 's', confirm: async () => true, onMessages: () => { throw new Error('disk full'); } },
        [],
        'go',
      ),
      /disk full|boom/,
    );
  });
});

// ─── regenerate / retry after a killed turn ──────────────────────────────────

describe('findRegenerationAnchor', () => {
  it('skips rows that only carry tool results', () => {
    const db = openDb(':memory:'); runMigrations(db);
    db.prepare("INSERT INTO conversations (id, title) VALUES ('c', 't')").run();
    const u = appendMessage(db, 'c', 'user', 'question');
    const a = appendMessage(db, 'c', 'assistant', [{ type: 'tool_use', id: 't1', name: 'x', input: {} }], u);
    appendMessage(db, 'c', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }, { type: 'text', text: 'from an agent' }], a);
    const anchor = findRegenerationAnchor(db, 'c', null)!;
    assert.equal(anchor.id, u);
    assert.equal(anchor.content, 'question');
    assert.equal(findRegenerationAnchor(db, 'empty', null), null);
    db.close();
  });
});

// ─── end to end: a failed turn is not lost ───────────────────────────────────

describe('a turn that fails after running a tool', () => {
  const TOKEN = 'p2-token';
  let built: BuiltApp; let server: http.Server; let port: number; let db: ReturnType<typeof openDb>;
  const calls: string[] = [];

  before(async () => {
    db = openDb(':memory:'); runMigrations(db);
    const llm = { messages: { ...scripted([msg([text('Listing…'), use('t1')], 'tool_use'), new Error('provider exploded')]).messages, batches: {} } };
    built = await buildApp({
      db, connections: [connection(calls)] as never, llm: llm as never, authToken: TOKEN,
      config: { model: '@test/model-a', autoApproveTools: ['run_bash'] },
    });
    server = built.app.listen(0); port = (server.address() as AddressInfo).port;
  });
  after(() => { built.stop(); server.close(); db.close(); });

  const call = (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
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

  it('keeps what the tool did in the conversation', async () => {
    const { id } = (await call('POST', '/api/conversations', {})).json;
    await call('POST', `/api/conversations/${id}/message`, { text: 'list the files' });
    for (let i = 0; i < 100; i++) {
      const s = (await call('GET', `/api/conversations/${id}/status`)).json;
      if (s.status && s.status !== 'running') { assert.equal(s.status, 'error'); break; }
      await new Promise(r => setTimeout(r, 30));
    }
    assert.deepEqual(calls, ['run_bash']);
    const rows = getAllMessagesFull(db, id);
    assert.deepEqual(rows.map(r => r.role), ['user', 'assistant', 'user']);
    assert.match(JSON.stringify(rows[1]!.content), /tool_use/);
    assert.match(JSON.stringify(rows[2]!.content), /listing/);
    // every stored tool_use has its result, and the rows hang off each other in one chain
    assert.equal(rows[1]!.parentId, rows[0]!.id);
    assert.equal(rows[2]!.parentId, rows[1]!.id);
  });
});

// ─── shutdown (audit S1) ─────────────────────────────────────────────────────

describe('shutdown', () => {
  const TOKEN = 's1-token';

  it('ends event streams, aborts a running turn and lets it store its work, so the HTTP server can close', async () => {
    const calls: string[] = [];
    let n = 0;
    const llm = {
      messages: {
        async create(_p: unknown, o?: { signal?: AbortSignal }) {
          if (++n === 1) return msg([use('t1')], 'tool_use');
          // the second request never answers by itself; it ends only when the turn is aborted
          return new Promise<Llm.Message>((_resolve, reject) => {
            o?.signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')));
          });
        },
        batches: {},
      },
    };
    const db = openDb(':memory:'); runMigrations(db);
    const built = await buildApp({ db, connections: [connection(calls)] as never, llm: llm as never, authToken: TOKEN, config: { model: '@test/model-a', autoApproveTools: ['run_bash'] } });
    const server = built.app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const request = (method: string, path: string, body?: unknown) => new Promise<any>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')));
      });
      r.on('error', reject);
      if (body !== undefined) r.write(JSON.stringify(body));
      r.end();
    });

    const { id } = await request('POST', '/api/conversations', {});
    let streamEnded = false;
    await new Promise<void>(resolve => {
      http.get({ host: '127.0.0.1', port, path: `/api/conversations/${id}/stream`, headers }, res => {
        res.on('data', () => {});
        res.on('end', () => { streamEnded = true; });
        resolve();
      });
    });
    await request('POST', `/api/conversations/${id}/message`, { text: 'go' });
    for (let i = 0; i < 100 && n < 2; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(n, 2, 'the turn is waiting on its second request');

    const started = Date.now();
    await built.shutdown();
    assert.ok(Date.now() - started < 3_000, 'does not run into the grace period');
    assert.deepEqual(getAllMessagesFull(db, id).map(r => r.role), ['user', 'assistant', 'user'], 'the finished step was stored');
    assert.equal((await request('GET', `/api/conversations/${id}/status`)).status, 'aborted');

    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    assert.equal(streamEnded, true);
    db.close();
  });
});
