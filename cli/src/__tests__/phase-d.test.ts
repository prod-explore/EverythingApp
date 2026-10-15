import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as Llm from '../llm-types.js';
import { runTurn, type LlmClient, type VirtualTool } from '../llm-loop.js';
import { ToolRegistry } from '../tool-registry.js';
import type { McpConnectionLike } from '../mcp-client.js';
import { OpenAiCompatClient, ProviderHttpError } from '../providers/openai-compat.js';
import { ProviderNotConfiguredError, ProviderRouter } from '../providers/router.js';
import { classifyError, contextLimitFromMessage } from '../providers/errors.js';
import { estimateTokens, planCompaction, renderTranscript, summarizeHistory, trimForContext, withSummary } from '../context.js';
import { parseTodos, projectInstructionsPrompt } from '../chat-tools.js';
import { appendMessage, appendSummary, createConversation, deactivateMessagesFrom, deleteMessagesFrom, getConversationState, getMessages, loadLlmHistory, openDb, runMigrations, setConversationState } from '../db.js';
import { llmHistory } from '../compaction.js';
import { buildApp } from '../server.js';
import { getModelInfo } from '../providers/registry.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null };
const msg = (content: unknown[], stop: Llm.StopReason, extra: Record<string, unknown> = {}): Llm.Message =>
  ({ id: 'm', content, model: '@t/m', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message', usage, ...extra }) as unknown as Llm.Message;
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });

function scripted(responses: Array<Llm.Message | ((p: Llm.MessageCreateParamsNonStreaming) => Llm.Message)>) {
  const calls: Llm.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  const llm: LlmClient = {
    messages: {
      async create(p) {
        calls.push(JSON.parse(JSON.stringify(p)));
        const r = responses[i++];
        if (!r) throw new Error('scripted client ran out of responses');
        return typeof r === 'function' ? r(p) : r;
      },
    },
  };
  return { llm, calls };
}

async function registry(executed: string[], autoApprove: string[] = []): Promise<ToolRegistry> {
  const conn: McpConnectionLike = {
    name: 's',
    async listTools() {
      return [
        { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
        { name: 'write_file', description: 'write', inputSchema: { type: 'object' } },
      ];
    },
    async callTool(name) {
      executed.push(name);
      return { text: `${name} ok`, isError: false };
    },
  };
  const r = new ToolRegistry(autoApprove);
  await r.loadFrom([conn]);
  return r;
}

const base = { model: '@t/m', systemPrompt: 'sys', confirm: async () => true as const };

// ─── error classification ────────────────────────────────────────────────────

describe('classifyError', () => {
  const http400 = (detail: string, status = 400) => new ProviderHttpError('openai', status, detail);

  it('recognises "context too long" in the wordings providers actually use, and reads the limit when named', () => {
    for (const d of [
      '{"error":{"code":"context_length_exceeded","message":"x"}}',
      "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens",
      'prompt is too long: 250000 tokens > 200000 maximum',
      'Input token count 1200000 exceeds the maximum number of tokens allowed 1048576',
      'Please reduce the length of the messages',
      'request too large for model',
    ]) {
      assert.equal(classifyError(http400(d)).kind, 'context_too_long', d);
    }
    assert.equal(classifyError(http400("maximum context length is 32768 tokens")).limit, 32768);
    assert.equal(contextLimitFromMessage('nothing useful'), undefined);
  });

  it('separates auth, budget, rate limit, busy, timeout, unconfigured and stop — each with a sentence a person can act on', () => {
    assert.equal(classifyError(http400('bad key', 401)).kind, 'auth');
    assert.equal(classifyError(http400('{"error":{"code":"budget_exhausted"}}', 402)).kind, 'budget_exhausted');
    const rl = classifyError(http400('slow down', 429));
    assert.deepEqual([rl.kind, rl.transient], ['rate_limited', true]);
    assert.equal(classifyError(http400('boom', 503)).kind, 'busy');
    assert.equal(classifyError(new Error('request timed out after 900000ms')).kind, 'timeout');
    assert.equal(classifyError(new ProviderNotConfiguredError('x', 'No key')).kind, 'not_configured');
    assert.equal(classifyError(new Error('Turn aborted by user (kill switch)')).kind, 'aborted');
    assert.equal(classifyError(http400('Invalid tool call: looks like object, can\'t find closing')).kind, 'tool_parse');
    const other = classifyError(new Error('something odd'));
    assert.deepEqual([other.kind, other.message], ['unknown', 'something odd']);
  });

  it('a 400 that merely mentions tokens is not an overflow', () => {
    assert.equal(classifyError(http400('invalid temperature')).kind, 'unknown');
  });

  it('redacts through the callback', () => {
    assert.equal(classifyError(new Error('boom sk-SECRET'), s => s.replace('sk-SECRET', '[redacted]')).message, 'boom [redacted]');
  });
});

// ─── context helpers ─────────────────────────────────────────────────────────

const userText = (t: string): Llm.MessageParam => ({ role: 'user', content: t });
const asstText = (t: string): Llm.MessageParam => ({ role: 'assistant', content: [{ type: 'text', text: t }] });
const call = (id: string, name = 'read_file'): Llm.MessageParam => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: { path: 'a' } }] });
const result = (id: string, out: string): Llm.MessageParam => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out }] });

describe('context helpers', () => {
  it('trimForContext stubs the OLDEST tool outputs first, keeps the newest, and never mutates its input', () => {
    const big = 'x'.repeat(40_000);
    const history = [userText('go'), call('1'), result('1', big), call('2'), result('2', big), call('3'), result('3', big), call('4'), result('4', big)];
    const before = JSON.stringify(history);
    const { messages, trimmed } = trimForContext(history, 30_000);
    assert.equal(JSON.stringify(history), before, 'input untouched');
    assert.ok(trimmed >= 1);
    const out = (i: number) => String(((messages[i]!.content as Llm.ToolResultBlockParam[])[0]!).content);
    assert.match(out(2), /Output dropped to save context/);
    assert.match(out(4), /Output dropped to save context/);
    assert.equal(out(6), big, 'stops as soon as the request fits');
    assert.equal(out(8), big, 'the newest result is intact');
    assert.equal(trimmed, 2);
    assert.ok(estimateTokens(messages) < estimateTokens(history));
  });

  it('trimForContext does nothing when the request fits', () => {
    const h = [userText('hi'), asstText('hello')];
    assert.equal(trimForContext(h, 10_000).messages, h);
  });

  it('planCompaction cuts at a user turn, keeps the last turns, and refuses a conversation too short to cut', () => {
    const rows = [userText('1'), asstText('a'), userText('2'), call('x'), result('x', 'r'), asstText('b'), userText('3'), asstText('c'), userText('4'), asstText('d')];
    const cut = planCompaction(rows, { keepTurns: 2 })!;
    assert.equal(rows[cut]!.role, 'user');
    assert.equal(cut, 8 - 2, 'keeps turns 3 and 4');
    assert.equal(planCompaction([userText('1'), asstText('a')]), null);
    assert.equal(planCompaction([userText('1'), call('x'), result('x', 'r'), asstText('b')]), null, 'a single user turn is never cut, however long its tool loop');
  });

  it('planCompaction shrinks the kept tail while it is too big', () => {
    const big = 'y'.repeat(30_000);
    const rows = [userText('1'), asstText('a'), userText('2'), asstText(big), userText('3'), asstText(big), userText('4'), asstText(big)];
    const cut = planCompaction(rows, { keepTurns: 3, maxTailTokens: 9_000 })!;
    assert.equal(cut, 6, 'only the last turn fits the tail budget');
  });

  it('summarizeHistory folds long histories in chunk by chunk, carrying the previous summary', async () => {
    const prompts: string[] = [];
    const llm: LlmClient = {
      messages: {
        async create(p) {
          prompts.push(String(p.messages[0]!.content));
          return msg([text(`S${prompts.length}`)], 'end_turn');
        },
      },
    };
    const messages = Array.from({ length: 6 }, (_, i) => userText(`message number ${i} ${'z'.repeat(200)}`));
    const s = await summarizeHistory({ llm, model: '@t/m', messages, previous: 'EARLIER', chunkChars: 500 });
    assert.ok(prompts.length >= 2, 'more than one request');
    assert.match(prompts[0]!, /EARLIER/);
    assert.match(prompts[1]!, /S1/);
    assert.equal(s, `S${prompts.length}`);
  });

  it('summarizeHistory rejects an empty summary instead of silently dropping the history', async () => {
    const llm: LlmClient = { messages: { async create() { return msg([], 'end_turn'); } } };
    await assert.rejects(summarizeHistory({ llm, model: '@t/m', messages: [userText('a'), asstText('b')] }), /empty summary/);
  });

  it('renderTranscript clips tool output and marks images', () => {
    const parts = renderTranscript([call('1'), result('1', 'q'.repeat(5000)), { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'u' } }] }], { toolChars: 100 });
    assert.match(parts[0]!, /Assistant called read_file/);
    assert.ok(parts[1]!.length < 200);
    assert.match(parts[2]!, /\[image\]/);
  });

  it('withSummary puts the summary into the first user message so roles keep alternating', () => {
    const out = withSummary('SUM', [userText('next'), asstText('ok')]);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.role, 'user');
    const blocks = out[0]!.content as Llm.TextBlockParam[];
    assert.match(blocks[0]!.text, /SUM/);
    assert.equal(blocks[1]!.text, 'next');
    assert.deepEqual(withSummary(null, [userText('x')]), [userText('x')]);
  });
});

// ─── storage ─────────────────────────────────────────────────────────────────

describe('compaction view in the database', () => {
  it('the model sees summary + messages after it; the UI list still has everything; a later summary supersedes', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const { id } = createConversation(db, {});
    const ids = [
      appendMessage(db, id, 'user', 'one'),
      appendMessage(db, id, 'assistant', [{ type: 'text', text: 'a' }]),
      appendMessage(db, id, 'user', 'two'),
      appendMessage(db, id, 'assistant', [{ type: 'text', text: 'b' }]),
      appendMessage(db, id, 'user', 'three'),
    ];
    assert.equal(loadLlmHistory(db, id).rows.length, 5);

    appendSummary(db, id, { text: 'S1', upTo: ids[1]!, replaced: 2 });
    const h1 = loadLlmHistory(db, id);
    assert.equal(h1.summary, 'S1');
    assert.deepEqual(h1.rows.map(r => r.id), [ids[2], ids[3], ids[4]]);
    assert.equal(getMessages(db, id).length, 6, 'raw list keeps originals plus the summary row');
    assert.equal(llmHistory(db, id)[0]!.role, 'user');

    // a turn that is about to send `ids[4]` must not see anything from it on
    assert.deepEqual(loadLlmHistory(db, id, ids[4]).rows.map(r => r.id), [ids[2], ids[3]]);

    appendSummary(db, id, { text: 'S2', upTo: ids[3]!, replaced: 2 });
    const h2 = loadLlmHistory(db, id);
    assert.equal(h2.summary, 'S2');
    assert.deepEqual(h2.rows.map(r => r.id), [ids[4]]);
  });

  it('a summary created for a turn that has not been sent yet is ignored by an earlier view', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const { id } = createConversation(db, {});
    const a = appendMessage(db, id, 'user', 'a');
    appendMessage(db, id, 'assistant', [{ type: 'text', text: 'x' }]);
    const c = appendMessage(db, id, 'user', 'c');
    appendSummary(db, id, { text: 'S', upTo: c, replaced: 3 });
    assert.equal(loadLlmHistory(db, id, c).summary, null, 'summary covers the very message being sent → not applicable');
    assert.equal(loadLlmHistory(db, id, c).rows.length, 2);
    assert.ok(a > 0);
  });

  it('retiring or deleting "from here" keeps a summary that only covers earlier messages, and drops one that covers the cut', () => {
    for (const how of ['deactivate', 'delete'] as const) {
      const db = openDb(':memory:');
      runMigrations(db);
      const { id } = createConversation(db, {});
      const m = [0, 1, 2, 3, 4, 5].map(i => appendMessage(db, id, i % 2 ? 'assistant' : 'user', i % 2 ? [{ type: 'text', text: `a${i}` }] : `u${i}`));
      const early = appendSummary(db, id, { text: 'covers 0-1', upTo: m[1]!, replaced: 2 }); // written after m[5], covers only m[0..1]
      const late = appendSummary(db, id, { text: 'covers 0-3', upTo: m[3]!, replaced: 4 });
      (how === 'deactivate' ? deactivateMessagesFrom : deleteMessagesFrom)(db, id, m[2]!);
      const left = getMessages(db, id).map(r => r.id!);
      assert.ok(left.includes(early), `${how}: summary below the cut survives`);
      assert.equal(left.includes(late), false, `${how}: summary that includes the cut goes`);
      assert.deepEqual(left.filter(x => m.includes(x)), [m[0], m[1]]);
      assert.equal(loadLlmHistory(db, id).summary, 'covers 0-1');
    }
  });

  it('conversation state round-trips, merges patches, and defaults sensibly', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const { id } = createConversation(db, {});
    assert.deepEqual(getConversationState(db, id), { effort: null, todos: [], lastInputTokens: null });
    setConversationState(db, id, { effort: 'high', lastInputTokens: 1234 });
    setConversationState(db, id, { todos: [{ content: 'x', status: 'pending' }] });
    assert.deepEqual(getConversationState(db, id), { effort: 'high', todos: [{ content: 'x', status: 'pending' }], lastInputTokens: 1234 });
  });
});

// ─── the loop ────────────────────────────────────────────────────────────────

describe('runTurn — invalid tool arguments', () => {
  it('does not run the tool (or ask for approval) and tells the model what to do; says so when the reply was cut off', async () => {
    const executed: string[] = [];
    let confirms = 0;
    const tools = await registry(executed);
    const { llm, calls } = scripted([
      msg([toolUse('1', 's__write_file', { __invalid_arguments: '{"path": "a", "content": "abc' })], 'tool_use', { cut_off: true }),
      msg([text('retrying')], 'end_turn'),
    ]);
    await runTurn({ ...base, llm, tools, confirm: async () => { confirms++; return true; } }, [], 'write it');
    assert.deepEqual(executed, []);
    assert.equal(confirms, 0);
    const r = (calls[1]!.messages.at(-1)!.content as Llm.ToolResultBlockParam[])[0]!;
    assert.equal(r.is_error, true);
    assert.match(String(r.content), /not valid JSON/);
    assert.match(String(r.content), /output limit/);
    assert.match(String(r.content), /abc/);
  });
});

describe('runTurn — propose_plan', () => {
  const planTool: VirtualTool = {
    definition: { name: 'propose_plan', description: 'p', input_schema: { type: 'object' } },
    requiresApproval: true,
    alwaysAsk: 'Approve this plan.',
    handler: async () => ({ text: 'approved' }),
  };

  it('is always asked, never covered by a grant, and an approved plan hands the model the go-ahead', async () => {
    const asked: Array<{ label: string; force?: string }> = [];
    const tools = await registry([], ['read_file']);
    const { llm, calls } = scripted([msg([toolUse('1', 'propose_plan', { plan: 'do X' })], 'tool_use'), msg([text('done')], 'end_turn')]);
    await runTurn(
      { ...base, llm, tools, virtualTools: [planTool], confirm: async (label, _a, o) => { asked.push({ label, force: o?.forcePrompt }); return true; } },
      [],
      'plan it',
    );
    const results = calls[1]!.messages.at(-1)!.content as Llm.ToolResultBlockParam[];
    assert.equal(results[0]!.content, 'approved');
    assert.deepEqual(asked, [{ label: 'propose_plan', force: 'Approve this plan.' }]);
  });

  it('a rejected plan never runs the handler', async () => {
    const executed: string[] = [];
    let ran = false;
    const tools = await registry(executed);
    const { llm, calls } = scripted([msg([toolUse('1', 'propose_plan', { plan: 'p' })], 'tool_use'), msg([text('revising')], 'end_turn')]);
    await runTurn(
      { ...base, llm, tools, virtualTools: [{ ...planTool, handler: async () => { ran = true; return { text: 'approved' }; } }], confirm: async () => ({ approved: false, reason: 'too vague' }) },
      [],
      'go',
    );
    assert.equal(ran, false);
    assert.match(String((calls[1]!.messages.at(-1)!.content as Llm.ToolResultBlockParam[])[0]!.content), /too vague/);
  });
});

describe('runTurn — context window', () => {
  it('sends a trimmed copy to the model but returns (and so stores) the full outputs; reports measured prompt size', async () => {
    const big = 'k'.repeat(60_000);
    const history: Llm.MessageParam[] = [userText('earlier'), call('a'), result('a', big), call('b'), result('b', big), call('c'), result('c', big), asstText('seen it')];
    const tools = await registry([]);
    const seen: Array<{ used: number; limit?: number }> = [];
    const { llm, calls } = scripted([msg([text('ok')], 'end_turn', { usage: { ...usage, input_tokens: 777 } })]);
    const out = await runTurn({ ...base, llm, tools, contextWindow: 20_000, onContext: c => seen.push(c) }, history, 'next');

    const sent = JSON.stringify(calls[0]!.messages);
    assert.match(sent, /Output dropped to save context/);
    assert.ok(sent.length < JSON.stringify(history).length / 2);
    assert.ok(JSON.stringify(out).includes(big), 'returned history keeps the full output');
    assert.deepEqual(seen, [{ used: 777, limit: 20_000 }]);
  });

  it('without a known window nothing is trimmed', async () => {
    const big = 'k'.repeat(60_000);
    const history: Llm.MessageParam[] = [userText('e'), call('a'), result('a', big), call('b'), result('b', big), call('c'), result('c', big), asstText('x')];
    const { llm, calls } = scripted([msg([text('ok')], 'end_turn')]);
    await runTurn({ ...base, llm, tools: await registry([]) }, history, 'next');
    assert.equal(JSON.stringify(calls[0]!.messages).includes('Output dropped'), false);
  });

  it('passes the reasoning effort on', async () => {
    const { llm, calls } = scripted([msg([text('ok')], 'end_turn')]);
    await runTurn({ ...base, llm, tools: await registry([]), reasoningEffort: 'low' }, [], 'hi');
    assert.equal(calls[0]!.reasoning_effort, 'low');
  });
});

// ─── adapter: reasoning effort ───────────────────────────────────────────────

describe('reasoning_effort on the wire', () => {
  const run = async (supportsEffort: boolean) => {
    let body: Record<string, unknown> = {};
    const client = new OpenAiCompatClient({
      baseUrl: 'https://x.example/v1',
      apiKey: 'k',
      meta: { get: () => null, set: () => {} },
      modelInfo: () => ({ ...getModelInfo('@t/m'), supportsEffort }),
      fetchImpl: (async (_u: unknown, init: { body: string }) => {
        body = JSON.parse(init.body);
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    });
    await client.messages.create({ model: '@t/m', max_tokens: 100, messages: [userText('x')], reasoning_effort: 'high' });
    return body;
  };

  it('is sent only to a model that supports it — the same rule for every provider', async () => {
    assert.equal((await run(true))['reasoning_effort'], 'high');
    assert.equal('reasoning_effort' in (await run(false)), false);
  });

  it('names the provider by its label in errors and retry notices', async () => {
    const retries: string[] = [];
    let n = 0;
    const client = new OpenAiCompatClient({
      label: 'My Gateway',
      baseUrl: 'https://x.example/v1',
      apiKey: 'k',
      meta: { get: () => null, set: () => {} },
      modelInfo: () => getModelInfo('@t/m'),
      sleep: async () => {},
      onRetry: i => retries.push(i.provider),
      fetchImpl: (async () => { n++; return new Response('{"error":{"message":"overloaded"}}', { status: 503 }); }) as unknown as typeof fetch,
    });
    await assert.rejects(client.messages.create({ model: '@t/m', max_tokens: 10, messages: [userText('x')] }), (e: Error) => e instanceof ProviderHttpError && e.provider === 'My Gateway' && /^My Gateway API error 503/.test(e.message));
    assert.ok(n >= 2);
    assert.deepEqual([...new Set(retries)], ['My Gateway']);
    assert.match(classifyError(new ProviderHttpError('My Gateway', 503, 'x')).message, /^My Gateway is not answering/);
  });

  it('flags a reply that was cut off while writing tool calls', async () => {
    const client = new OpenAiCompatClient({
      baseUrl: 'https://x.example/v1',
      apiKey: 'k',
      meta: { get: () => null, set: () => {} },
      modelInfo: () => getModelInfo('@t/m'),
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{"a": ' } }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    });
    const r = await client.messages.create({ model: '@t/m', max_tokens: 100, messages: [userText('x')] });
    assert.equal(r.cut_off, true);
    assert.equal(r.stop_reason, 'tool_use');
  });
});

describe('chat tools', () => {
  it('parseTodos validates the list for the model', () => {
    assert.deepEqual(parseTodos({ todos: [{ content: ' a ', status: 'pending' }] }), [{ content: 'a', status: 'pending' }]);
    assert.match(String(parseTodos({})), /todos/);
    assert.match(String(parseTodos({ todos: [{ content: '', status: 'pending' }] })), /Item 1/);
    assert.match(String(parseTodos({ todos: [{ content: 'a', status: 'done' }] })), /status/);
    assert.match(String(parseTodos({ todos: Array.from({ length: 41 }, () => ({ content: 'a', status: 'pending' })) })), /at most/);
  });

  it('projectInstructionsPrompt names the file and caps its size', () => {
    const p = projectInstructionsPrompt('x'.repeat(30_000));
    assert.match(p, /AGENTS\.md/);
    assert.ok(p.length < 21_000);
  });
});

// ─── whole server ────────────────────────────────────────────────────────────

const TOKEN = 't';
function req(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request(
      { host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } },
      res => {
        const c: Buffer[] = [];
        res.on('data', d => c.push(d));
        res.on('end', () => {
          const t = Buffer.concat(c).toString();
          resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const waitFor = async (cond: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 15));
  }
};

/** Polls an async condition; unlike a fire-and-forget request inside waitFor, nothing is left in flight when it returns. */
const poll = async <T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error('poll timed out');
    await new Promise(r => setTimeout(r, 15));
  }
};

async function boot(opts: { model?: Record<string, unknown>; script: (p: Llm.MessageCreateParamsNonStreaming, n: number) => Llm.Message | Error; settings?: Record<string, string> }) {
  const seen: Llm.MessageCreateParamsNonStreaming[] = [];
  const client = {
    messages: {
      async create(p: Llm.MessageCreateParamsNonStreaming) {
        seen.push(JSON.parse(JSON.stringify(p)));
        const r = opts.script(p, seen.length);
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
  const db = openDb(':memory:');
  runMigrations(db);
  for (const [k, v] of Object.entries(opts.settings ?? {})) db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(k, v);
  const router = new ProviderRouter({ db, env: {}, llmOverride: client as any });
  router.catalog.create({ slug: 't', label: 'Test', baseUrl: 'https://t.example/v1', keyOptional: true });
  router.catalog.addManual('t', 'm', { tags: [], ...(opts.model ?? {}) });
  const built = await buildApp({ db, connections: [], router, authToken: TOKEN, config: { model: '', autoApproveTools: [] } });
  const server = built.app.listen(0);
  await new Promise<void>(r => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  const conv = (await req(port, 'POST', '/api/conversations', { model: '@t/m' })).json.id as string;
  return { db, port, conv, seen, stop: () => { built.stop(); server.close(); db.close(); } };
}
const isSummaryCall = (p: Llm.MessageCreateParamsNonStreaming) => /compress the earlier part/i.test(String(p.system));
const done = (db: ReturnType<typeof openDb>, conv: string, n: number) => waitFor(() => getMessages(db, conv).filter(m => m.role !== 'summary').length >= n);

describe('server: conversation state', () => {
  it('reads and validates effort, reports what the model supports, and clears the todo list', async () => {
    const t = await boot({ model: { contextLength: 50_000, supportsEffort: true }, script: () => msg([text('hi')], 'end_turn') });
    try {
      const s0 = (await req(t.port, 'GET', `/api/conversations/${t.conv}/state`)).json;
      assert.deepEqual([s0.effort, s0.effortSupported, s0.todos, s0.context], [null, true, [], { used: null, limit: 50_000 }]);
      assert.equal('mode' in s0, false);
      assert.equal((await req(t.port, 'PATCH', `/api/conversations/${t.conv}/state`, { effort: 'extreme' })).status, 400);
      const s1 = (await req(t.port, 'PATCH', `/api/conversations/${t.conv}/state`, { effort: 'low' })).json;
      assert.equal(s1.effort, 'low');
      setConversationState(t.db, t.conv, { todos: [{ content: 'a', status: 'pending' }] });
      assert.deepEqual((await req(t.port, 'PATCH', `/api/conversations/${t.conv}/state`, { clearTodos: true, effort: null })).json.todos, []);
      assert.equal((await req(t.port, 'GET', '/api/conversations/nope/state')).status, 404);
    } finally {
      t.stop();
    }
  });
});

describe('server: a normal turn', () => {
  it('adds custom instructions + working style to the system prompt, sends the chosen effort, records the measured prompt size and lets the model keep a todo list', async () => {
    const t = await boot({
      model: { supportsEffort: true, contextLength: 100_000 },
      settings: { custom_instructions: 'Answer in Polish.' },
      script: (_p, n) =>
        n === 1
          ? msg([toolUse('1', 'todo_write', { todos: [{ content: 'step one', status: 'in_progress' }, { content: 'step two', status: 'pending' }] })], 'tool_use')
          : msg([text('gotowe')], 'end_turn', { usage: { ...usage, input_tokens: 4321 } }),
    });
    try {
      await req(t.port, 'PATCH', `/api/conversations/${t.conv}/state`, { effort: 'medium' });
      await req(t.port, 'POST', `/api/conversations/${t.conv}/message`, { text: 'zrób to' });
      await done(t.db, t.conv, 4);

      const sys = String(t.seen[0]!.system);
      assert.match(sys, /custom instructions:\nAnswer in Polish\./);
      assert.match(sys, /todo_write/);
      assert.match(sys, /propose_plan/);
      assert.equal(t.seen[0]!.reasoning_effort, 'medium');
      assert.ok(t.seen[0]!.tools!.some(x => x.name === 'todo_write'));
      assert.ok(t.seen[0]!.tools!.some(x => x.name === 'propose_plan'), 'the model can propose a plan whenever it judges one is needed');

      const st = (await req(t.port, 'GET', `/api/conversations/${t.conv}/state`)).json;
      assert.deepEqual(st.todos, [{ content: 'step one', status: 'in_progress' }, { content: 'step two', status: 'pending' }]);
      assert.deepEqual(st.context, { used: 4321, limit: 100_000 });
    } finally {
      t.stop();
    }
  });
});

describe('server: propose_plan through the approval gate', () => {
  it('shows the plan for approval and, once approved, tells the model to carry it out', async () => {
    const t = await boot({
      script: (_p, n) => (n === 1 ? msg([toolUse('1', 'propose_plan', { plan: '1. read\n2. change' })], 'tool_use') : msg([text('starting')], 'end_turn')),
    });
    try {
      await req(t.port, 'POST', `/api/conversations/${t.conv}/message`, { text: 'refactor' });
      await waitFor(() => t.seen.length === 1);
      assert.ok(t.seen[0]!.tools!.some(x => x.name === 'propose_plan'));

      const pending: any[] = (await poll(() => req(t.port, 'GET', '/api/pending-approvals'), r => r.json.pending.length === 1)).json.pending;
      assert.equal(pending[0].toolLabel, 'propose_plan');
      assert.equal(pending[0].args.plan, '1. read\n2. change');
      assert.equal(pending[0].dangerous, true, 'a plan is never covered by "always allow"');

      await req(t.port, 'POST', '/api/approve', { id: pending[0].id, approved: true });
      await done(t.db, t.conv, 4);
      const fed = (t.seen[1]!.messages.at(-1)!.content as Llm.ToolResultBlockParam[])[0]!;
      assert.match(String(fed.content), /approved the plan/);
    } finally {
      t.stop();
    }
  });
});

describe('server: context management', () => {
  const longChat = (db: ReturnType<typeof openDb>, conv: string) => {
    for (let i = 0; i < 6; i++) {
      appendMessage(db, conv, 'user', `question ${i} ${'q'.repeat(2000)}`);
      appendMessage(db, conv, 'assistant', [{ type: 'text', text: `answer ${i} ${'a'.repeat(2000)}` }]);
    }
  };

  it('compacts before the turn when the window would overflow: the model gets summary + recent turns, the UI keeps the originals', async () => {
    const t = await boot({
      model: { contextLength: 4_000 },
      script: p => (isSummaryCall(p) ? msg([text('SUMMARY: user asked six things')], 'end_turn') : msg([text('answer')], 'end_turn')),
    });
    try {
      longChat(t.db, t.conv);
      const before = getMessages(t.db, t.conv).length;
      await req(t.port, 'POST', `/api/conversations/${t.conv}/message`, { text: 'and now?' });
      await done(t.db, t.conv, before + 2);

      const chatCalls = t.seen.filter(p => !isSummaryCall(p));
      assert.equal(t.seen.filter(isSummaryCall).length, 1);
      const first = chatCalls[0]!.messages[0]!;
      assert.match(JSON.stringify(first), /SUMMARY: user asked six things/);
      assert.ok(chatCalls[0]!.messages.length < before + 1, 'older messages were replaced');
      assert.equal(chatCalls[0]!.messages.at(-1)!.role, 'user');

      const all = getMessages(t.db, t.conv);
      assert.equal(all.filter(m => m.role === 'summary').length, 1);
      assert.ok(all.some(m => JSON.stringify(m.content).includes('question 0')), 'originals are still stored');

      // the next turn starts from the summary too — it is not recomputed
      await req(t.port, 'POST', `/api/conversations/${t.conv}/message`, { text: 'one more' });
      await done(t.db, t.conv, before + 4);
      assert.equal(t.seen.filter(isSummaryCall).length, 1, 'no second summary while it still fits');
    } finally {
      t.stop();
    }
  });

  it('does nothing about the window when it is unknown', async () => {
    const t = await boot({ script: () => msg([text('ok')], 'end_turn') });
    try {
      longChat(t.db, t.conv);
      const before = getMessages(t.db, t.conv).length;
      await req(t.port, 'POST', `/api/conversations/${t.conv}/message`, { text: 'hi' });
      await done(t.db, t.conv, before + 2);
      assert.equal(t.seen.length, 1);
    } finally {
      t.stop();
    }
  });

  it('on "context too long" from the provider: compacts once and repeats the request', async () => {
    let chatAttempts = 0;
    const t = await boot({
      script: p => {
        if (isSummaryCall(p)) return msg([text('SHORT SUMMARY')], 'end_turn');
        chatAttempts++;
        if (chatAttempts === 1) return new ProviderHttpError('t', 400, "This model's maximum context length is 8192 tokens");
        return msg([text('fits now')], 'end_turn');
      },
    });
    try {
      longChat(t.db, t.conv);
      const before = getMessages(t.db, t.conv).length;
      await req(t.port, 'POST', `/api/conversations/${t.conv}/message`, { text: 'again' });
      await done(t.db, t.conv, before + 2);
      assert.equal(chatAttempts, 2);
      assert.match(JSON.stringify(t.seen.filter(p => !isSummaryCall(p))[1]!.messages[0]), /SHORT SUMMARY/);
      assert.equal((await req(t.port, 'GET', `/api/conversations/${t.conv}/status`)).json.status, 'done');
    } finally {
      t.stop();
    }
  });

  it('when compaction cannot help (a single huge turn) the person gets the plain-language error with its kind', async () => {
    const t = await boot({ script: () => new ProviderHttpError('t', 400, "maximum context length is 8192 tokens") });
    try {
      await req(t.port, 'POST', `/api/conversations/${t.conv}/message`, { text: 'x'.repeat(100) });
      const status = (await poll(() => req(t.port, 'GET', `/api/conversations/${t.conv}/status`), r => r.json.status === 'error')).json;
      assert.equal(status.kind, 'context_too_long');
      assert.match(status.error, /no longer fits this model's context window \(8,192 tokens\)/);
    } finally {
      t.stop();
    }
  });

  it('POST /compact summarises now, and says so when there is nothing to cut', async () => {
    const t = await boot({ script: p => (isSummaryCall(p) ? msg([text('MANUAL SUMMARY')], 'end_turn') : msg([text('ok')], 'end_turn')) });
    try {
      const empty = await req(t.port, 'POST', `/api/conversations/${t.conv}/compact`);
      assert.deepEqual([empty.status, empty.json.compacted], [200, false]);
      longChat(t.db, t.conv);
      const r = await req(t.port, 'POST', `/api/conversations/${t.conv}/compact`);
      assert.deepEqual([r.status, r.json.compacted], [200, true]);
      assert.match(JSON.stringify(llmHistory(t.db, t.conv)[0]), /MANUAL SUMMARY/);
      assert.equal((await req(t.port, 'POST', '/api/conversations/nope/compact')).status, 404);
    } finally {
      t.stop();
    }
  });

  it('a failing summariser never blocks the turn', async () => {
    const t = await boot({
      model: { contextLength: 4_000 },
      script: p => (isSummaryCall(p) ? new Error('helper is down') : msg([text('still answered')], 'end_turn')),
    });
    try {
      longChat(t.db, t.conv);
      const before = getMessages(t.db, t.conv).length;
      await req(t.port, 'POST', `/api/conversations/${t.conv}/message`, { text: 'hello' });
      await done(t.db, t.conv, before + 2);
      assert.equal(getMessages(t.db, t.conv).filter(m => m.role === 'summary').length, 0);
    } finally {
      t.stop();
    }
  });
});

describe('server: errors a person can act on', () => {
  it('turns a provider 401 into a sentence and keeps the provider text as detail', async () => {
    const t = await boot({ script: () => new ProviderHttpError('t', 401, 'bad api key sk-123') });
    try {
      await req(t.port, 'POST', `/api/conversations/${t.conv}/message`, { text: 'hi' });
      const s = (await poll(() => req(t.port, 'GET', `/api/conversations/${t.conv}/status`), r => r.json.status === 'error')).json;
      assert.equal(s.kind, 'auth');
      assert.match(s.error, /rejected the API key/);
    } finally {
      t.stop();
    }
  });
});

describe('server: AGENTS.md', () => {
  it('a project workspace with an AGENTS.md puts it in the system prompt; without one nothing is added', async () => {
    const asked: string[] = [];
    let present = true;
    const supervisor = http.createServer((rq, rs) => {
      asked.push(rq.url ?? '');
      if ((rq.url ?? '').includes('/file?')) {
        if (!present) { rs.statusCode = 404; rs.setHeader('content-type', 'application/json'); rs.end('{"error":"no such file"}'); return; }
        rs.setHeader('content-type', 'text/plain');
        rs.end('Use tabs. Run npm test before saying done.');
        return;
      }
      rs.setHeader('content-type', 'application/json');
      rs.end('{}');
    });
    await new Promise<void>(r => supervisor.listen(0, r));
    process.env['SUPERVISOR_URL'] = `http://127.0.0.1:${(supervisor.address() as AddressInfo).port}`;
    const t = await boot({ script: () => msg([text('ok')], 'end_turn') });
    try {
      const sandboxed = (await req(t.port, 'POST', '/api/conversations', { model: '@t/m', sandboxEnabled: true })).json.id as string;
      await req(t.port, 'POST', `/api/conversations/${sandboxed}/message`, { text: 'hi' });
      await done(t.db, sandboxed, 2);
      assert.match(String(t.seen[0]!.system), /Project instructions \(from AGENTS\.md[^)]*\)[\s\S]*Use tabs\. Run npm test/);

      present = false;
      await req(t.port, 'POST', `/api/conversations/${sandboxed}/message`, { text: 'again' });
      await done(t.db, sandboxed, 4);
      assert.equal(String(t.seen[1]!.system).includes('Project instructions'), false);

      // chats without a sandbox never ask for the file
      const before = asked.length;
      await req(t.port, 'POST', `/api/conversations/${t.conv}/message`, { text: 'plain' });
      await done(t.db, t.conv, 2);
      assert.equal(asked.length, before);
    } finally {
      t.stop();
      supervisor.close();
      delete process.env['SUPERVISOR_URL'];
    }
  });
});

describe('model metadata for the context window and reasoning effort', () => {
  it('reads them from /models (supports: reasoning_effort, OpenRouter supported_parameters) and from a user override', async () => {
    const { parseDiscoveredModel } = await import('../providers/catalog.js');
    assert.equal(parseDiscoveredModel({ id: 'a', supports: ['tools', 'reasoning_effort'], context_length: 65536 })!.reported.supportsEffort, true);
    assert.equal(parseDiscoveredModel({ id: 'b', supported_parameters: ['tools', 'reasoning_effort'] })!.reported.supportsEffort, true);
    assert.equal(parseDiscoveredModel({ id: 'c', supports: ['tools'] })!.reported.supportsEffort, undefined);
    assert.equal(parseDiscoveredModel({ id: 'a', context_length: 65536 })!.reported.contextLength, 65536);

    const t = await boot({ script: () => msg([text('x')], 'end_turn') });
    try {
      assert.equal(getModelInfo('@t/m').supportsEffort, false);
      assert.equal((await req(t.port, 'PATCH', '/api/models', { id: '@t/m', supportsEffort: true, contextLength: 32000 })).status, 200);
      assert.deepEqual([getModelInfo('@t/m').supportsEffort, getModelInfo('@t/m').contextLength], [true, 32000]);
      assert.equal((await req(t.port, 'PATCH', '/api/models', { id: '@t/m', supportsEffort: null, contextLength: null })).status, 200);
      assert.deepEqual([getModelInfo('@t/m').supportsEffort, getModelInfo('@t/m').contextLength], [false, undefined]);
    } finally {
      t.stop();
    }
  });
});
