import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { runTurn } from '../anthropic-loop.js';
import { ToolRegistry } from '../tool-registry.js';
import type { McpConnectionLike } from '../mcp-client.js';
import { getModelInfo } from '../providers/registry.js';
import {
  OpenAiCompatClient,
  ProviderHttpError,
  fromChatResponse,
  safeToolName,
  sanitizeSchemaForGemini,
  toChatMessages,
  toChatTools,
  type MetaStore,
  type TranslateContext,
} from '../providers/openai-compat.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function memoryMeta(): MetaStore & { store: Map<string, Record<string, unknown>> } {
  const store = new Map<string, Record<string, unknown>>();
  return { store, get: id => store.get(id) ?? null, set: (id, m) => void store.set(id, m) };
}

// NameMap isn't exported; toChatTools/toChatMessages only need something with safe()/original().
function ctxFor(flavor: 'gemini' | 'deepseek', model: string, meta: MetaStore = memoryMeta()): TranslateContext {
  const map = new Map<string, string>();
  return {
    flavor,
    modelInfo: getModelInfo(model),
    meta,
    names: {
      safe(original: string) {
        const s = safeToolName(original);
        map.set(s, original);
        return s;
      },
      original: (s: string) => map.get(s) ?? s,
    } as unknown as TranslateContext['names'],
  };
}

const params = (messages: Anthropic.MessageParam[], extra: Partial<Anthropic.MessageCreateParamsNonStreaming> = {}) =>
  ({ model: 'x', max_tokens: 100, messages, ...extra }) as Anthropic.MessageCreateParamsNonStreaming;

// ─── request translation ─────────────────────────────────────────────────────

describe('toChatMessages', () => {
  it('emits tool results as tool messages directly after the assistant tool_calls, before any user text', () => {
    const out = toChatMessages(
      params(
        [
          { role: 'user', content: 'list files' },
          { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'call_1', name: 'sandbox__run_bash', input: { cmd: 'ls' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'a.txt' }, { type: 'text', text: 'thanks' }] },
        ],
        { system: [{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }] },
      ),
      ctxFor('deepseek', 'deepseek-chat'),
    );
    assert.deepEqual(out.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
    assert.equal((out[0] as { content: string }).content, 'be brief');
    const assistant = out[2] as { content: string; tool_calls: Array<{ id: string; function: { arguments: string } }> };
    assert.equal(assistant.content, 'ok');
    assert.equal(assistant.tool_calls[0]!.id, 'call_1');
    assert.deepEqual(JSON.parse(assistant.tool_calls[0]!.function.arguments), { cmd: 'ls' });
    assert.deepEqual(out[3], { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' });
  });

  it('marks failed tool results and never sends an empty tool message', () => {
    const out = toChatMessages(
      params([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }, { type: 'tool_use', id: 'c2', name: 't', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true }, { type: 'tool_result', tool_use_id: 'c2', content: '' }] },
      ]),
      ctxFor('deepseek', 'deepseek-chat'),
    );
    const tools = out.filter(m => m.role === 'tool') as Array<{ content: string }>;
    assert.equal(tools[0]!.content, 'Error: boom');
    assert.equal(tools[1]!.content, '(no output)');
  });

  it('drops images for text-only models but forwards them (as data URLs) to vision models', () => {
    const msg: Anthropic.MessageParam = {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: 'what is this?' },
      ],
    };
    const ds = toChatMessages(params([msg]), ctxFor('deepseek', 'deepseek-chat'));
    assert.match((ds[0] as { content: string }).content, /image attachment omitted/);

    const gem = toChatMessages(params([msg]), ctxFor('gemini', 'gemini-3.8-flash'));
    const parts = (gem[0] as { content: Array<{ type: string; image_url?: { url: string } }> }).content;
    assert.equal(parts[0]!.image_url!.url, 'data:image/png;base64,AAAA');
  });

  it('flattens Anthropic-only blocks (web search, thinking) so a chat can switch providers mid-way', () => {
    const out = toChatMessages(
      params([
        { role: 'user', content: 'news?' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm', signature: 'sig' },
            { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'polish news' } },
            { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', title: 'TVN24', url: 'https://tvn24.pl', encrypted_content: 'x', page_age: null }] },
            { type: 'text', text: 'Here is the news.' },
          ] as unknown as Anthropic.ContentBlockParam[],
        },
        { role: 'user', content: 'thanks' },
      ]),
      ctxFor('deepseek', 'deepseek-chat'),
    );
    const assistant = out[1] as { content: string };
    assert.match(assistant.content, /searched the web: "polish news"/);
    assert.match(assistant.content, /TVN24/);
    assert.match(assistant.content, /Here is the news\./);
    assert.ok(!assistant.content.includes('hmm'), 'thinking text must not leak');
  });

  it('gemini: replays stored thought signatures and adds Google\'s documented stand-in only when none exists', () => {
    const meta = memoryMeta();
    meta.set('fc_real', { thoughtSignature: 'REAL-SIG' });
    const history = (id: string): Anthropic.MessageParam[] => [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id, name: 'obsidian__get_path', input: { path: '' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    ];

    const real = toChatMessages(params(history('fc_real')), ctxFor('gemini', 'gemini-3.8-flash', meta));
    const realCall = (real[1] as { tool_calls: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }).tool_calls[0]!;
    assert.equal(realCall.extra_content?.google?.thought_signature, 'REAL-SIG');
    assert.equal((real[2] as { name?: string }).name, 'obsidian__get_path');

    const foreign = toChatMessages(params(history('toolu_from_claude')), ctxFor('gemini', 'gemini-3.8-flash', meta));
    const foreignCall = (foreign[1] as { tool_calls: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }).tool_calls[0]!;
    assert.equal(foreignCall.extra_content?.google?.thought_signature, 'skip_thought_signature_validator');
  });

  it('deepseek: echoes reasoning_content during the current tool loop only, never for earlier turns', () => {
    const meta = memoryMeta();
    meta.set('old', { reasoningContent: 'old reasoning' });
    meta.set('cur', { reasoningContent: 'current reasoning' });
    const out = toChatMessages(
      params([
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 't', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'r' }] },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'second question' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'cur', name: 't', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cur', content: 'r' }] },
      ]),
      ctxFor('deepseek', 'deepseek-reasoner', meta),
    );
    const assistants = out.filter(m => m.role === 'assistant') as Array<{ reasoning_content?: string; tool_calls?: unknown }>;
    assert.equal(assistants[0]!.reasoning_content, undefined);
    assert.equal(assistants[2]!.reasoning_content, 'current reasoning');
  });
});

describe('toChatTools / schema handling', () => {
  it('skips Anthropic server tools and keeps custom ones', () => {
    const tools = toChatTools(
      [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
        { name: 'echo', description: 'Echo', input_schema: { type: 'object', properties: { text: { type: 'string' } } } },
      ] as Anthropic.MessageCreateParams['tools'],
      ctxFor('deepseek', 'deepseek-chat'),
    );
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.function.name, 'echo');
  });

  it('gemini: strips $schema/additionalProperties and drops parameters for no-arg tools', () => {
    const cleaned = sanitizeSchemaForGemini({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string', additionalProperties: false } },
    });
    assert.deepEqual(cleaned, { type: 'object', properties: { path: { type: 'string' } } });
    assert.equal(sanitizeSchemaForGemini({ type: 'object', properties: {} }), undefined);
  });

  it('shortens over-long MCP tool names reversibly', () => {
    const long = 'my_server__' + 'x'.repeat(80);
    const safe = safeToolName(long);
    assert.ok(safe.length <= 64);
    assert.equal(safeToolName(long), safe, 'must be deterministic');
    assert.notEqual(safeToolName(long + 'y'), safe, 'different names must not collide');
    assert.equal(safeToolName('obsidian__get_path'), 'obsidian__get_path');
  });
});

// ─── response translation ────────────────────────────────────────────────────

describe('fromChatResponse', () => {
  it('turns tool_calls into tool_use blocks and forces stop_reason tool_use even when finish_reason says "stop"', () => {
    const meta = memoryMeta();
    const msg = fromChatResponse(
      {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: null,
              tool_calls: [
                { id: 'function-call-abc', function: { name: 'echo', arguments: '{"text":"hi"}' }, extra_content: { google: { thought_signature: 'SIG' } } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      },
      'gemini-3.8-flash',
      ctxFor('gemini', 'gemini-3.8-flash', meta),
      'gemini',
    );
    assert.equal(msg.stop_reason, 'tool_use');
    const use = msg.content.find(b => b.type === 'tool_use') as Anthropic.ToolUseBlock;
    assert.deepEqual(use.input, { text: 'hi' });
    assert.deepEqual(meta.store.get('function-call-abc'), { thoughtSignature: 'SIG' });
  });

  it('survives malformed tool arguments and missing ids instead of throwing', () => {
    const msg = fromChatResponse(
      { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 't', arguments: '{"a": ' } }] } }] },
      'deepseek-chat',
      ctxFor('deepseek', 'deepseek-chat'),
      'deepseek',
    );
    const use = msg.content[0] as Anthropic.ToolUseBlock;
    assert.match(use.id, /^[a-zA-Z0-9_-]+$/, 'Anthropic requires ^[a-zA-Z0-9_-]+$ ids');
    assert.deepEqual(use.input, { __invalid_arguments: '{"a": ' });
  });

  it('maps finish reasons and stores deepseek reasoning against the first tool call', () => {
    const meta = memoryMeta();
    const truncated = fromChatResponse(
      { choices: [{ finish_reason: 'length', message: { content: 'cut of' } }] },
      'deepseek-chat',
      ctxFor('deepseek', 'deepseek-chat'),
      'deepseek',
    );
    assert.equal(truncated.stop_reason, 'max_tokens');

    fromChatResponse(
      { choices: [{ finish_reason: 'tool_calls', message: { reasoning_content: 'because', tool_calls: [{ id: 'a', function: { name: 't', arguments: '{}' } }, { id: 'b', function: { name: 't', arguments: '{}' } }] } }] },
      'deepseek-reasoner',
      ctxFor('deepseek', 'deepseek-reasoner', meta),
      'deepseek',
    );
    assert.deepEqual(meta.store.get('a'), { reasoningContent: 'because' });
    assert.equal(meta.store.has('b'), false);
  });

  it('separates cached prompt tokens from fresh ones (deepseek and openai-style usage)', () => {
    const ds = fromChatResponse(
      { choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_cache_hit_tokens: 800 } },
      'deepseek-chat',
      ctxFor('deepseek', 'deepseek-chat'),
      'deepseek',
    );
    assert.equal(ds.usage.input_tokens, 200);
    assert.equal(ds.usage.cache_read_input_tokens, 800);

    const gem = fromChatResponse(
      { choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 500, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 100 } } },
      'gemini-3.8-flash',
      ctxFor('gemini', 'gemini-3.8-flash'),
      'gemini',
    );
    assert.equal(gem.usage.input_tokens, 400);
    assert.equal(gem.usage.cache_read_input_tokens, 100);
  });
});

// ─── client (HTTP behaviour) ─────────────────────────────────────────────────

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown; headers?: Record<string, string> }) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const i = init ?? {};
    calls.push({ url: u, init: i, body: i.body ? JSON.parse(String(i.body)) : undefined });
    const r = handler(u, i);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return { impl, calls };
}

function newClient(f: typeof fetch, extra: Partial<ConstructorParameters<typeof OpenAiCompatClient>[0]> = {}) {
  return new OpenAiCompatClient({
    flavor: 'deepseek',
    baseUrl: 'https://api.example.test',
    apiKey: 'sk-live-SECRET-KEY',
    meta: memoryMeta(),
    modelInfo: getModelInfo,
    fetchImpl: f,
    sleep: async () => {},
    ...extra,
  });
}

describe('OpenAiCompatClient', () => {
  it('runs the shared tool loop end-to-end against a chat-completions server', async () => {
    let n = 0;
    const { impl, calls } = fakeFetch(() => {
      n += 1;
      return n === 1
        ? {
            status: 200,
            body: { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'sandbox__run_bash', arguments: '{"cmd":"echo hi"}' } }] } }], usage: { prompt_tokens: 50, completion_tokens: 10 } },
          }
        : { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'It printed hi.' } }], usage: { prompt_tokens: 80, completion_tokens: 6 } } };
    });

    const executed: string[] = [];
    const conn: McpConnectionLike = {
      name: 'sandbox',
      listTools: async () => [{ name: 'run_bash', description: 'run', inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } } }],
      callTool: async (name, args) => {
        executed.push(`${name}:${JSON.stringify(args)}`);
        return { text: 'hi', isError: false };
      },
    };
    const registry = new ToolRegistry(['run_bash']);
    await registry.loadFrom([conn]);
    const usages: Anthropic.Usage[] = [];

    const history = await runTurn(
      { anthropic: newClient(impl), model: 'deepseek-chat', tools: registry, systemPrompt: 'sys', confirm: async () => true, onUsage: u => usages.push(u) },
      [],
      'run echo hi',
    );

    assert.deepEqual(executed, ['run_bash:{"cmd":"echo hi"}']);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, 'https://api.example.test/chat/completions');
    assert.equal((calls[0]!.init.headers as Record<string, string>)['Authorization'], 'Bearer sk-live-SECRET-KEY');
    // second request must carry the assistant tool_call and its tool result
    assert.deepEqual(calls[1]!.body.messages.map((m: { role: string }) => m.role), ['system', 'user', 'assistant', 'tool']);
    assert.equal(usages.length, 2);
    const last = history[history.length - 1]!;
    assert.equal(last.role, 'assistant');
    assert.match(JSON.stringify(last.content), /It printed hi\./);
  });

  it('raises max_tokens to the model floor for reasoning models', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } }));
    await newClient(impl).messages.create(params([{ role: 'user', content: 'hi' }], { model: 'deepseek-reasoner', max_tokens: 4096 }));
    assert.equal(calls[0]!.body.max_tokens, 16000);
    await newClient(impl).messages.create(params([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat', max_tokens: 4096 }));
    assert.equal(calls[1]!.body.max_tokens, 4096);
  });

  it('retries transient failures, then gives up with a redacted error', async () => {
    let attempts = 0;
    const flaky = fakeFetch(() => {
      attempts += 1;
      return attempts < 3 ? { status: 503, body: 'overloaded' } : { status: 200, body: { choices: [{ message: { content: 'finally' } }] } };
    });
    const ok = await newClient(flaky.impl).messages.create(params([{ role: 'user', content: 'hi' }]));
    assert.equal(attempts, 3);
    assert.equal((ok.content[0] as Anthropic.TextBlock).text, 'finally');

    // An upstream that echoes the key back in its error body must not leak it.
    const leaky = fakeFetch(() => ({ status: 401, body: 'invalid key sk-live-SECRET-KEY provided' }));
    await assert.rejects(
      newClient(leaky.impl).messages.create(params([{ role: 'user', content: 'hi' }])),
      (err: Error) => err instanceof ProviderHttpError && err.status === 401 && !err.message.includes('SECRET-KEY') && err.message.includes('[redacted]'),
    );
    assert.equal(leaky.calls.length, 1, '401 is not retryable');
  });

  it('honours the abort signal (kill switch) mid-request', async () => {
    const controller = new AbortController();
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')));
      })) as typeof fetch;
    const pending = newClient(hanging).messages.create(params([{ role: 'user', content: 'hi' }]), { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, /abort/i);
  });
});
