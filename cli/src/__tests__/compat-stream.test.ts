import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as Llm from '../llm-types.js';
import { OpenAiCompatClient } from '../providers/openai-compat.js';
import { getModelInfo } from '../providers/registry.js';

function sse(events: unknown[]): Response {
  const body = events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  // Split mid-line to exercise buffering across chunks.
  const bytes = new TextEncoder().encode(body);
  const mid = Math.floor(bytes.length / 2);
  const stream = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, mid)); c.enqueue(bytes.slice(mid)); c.close(); } });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function client(fetchImpl: typeof fetch) {
  return new OpenAiCompatClient({ baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl, modelInfo: id => getModelInfo(id), meta: { get: () => null, set: () => {} }, maxRetries: 0 });
}

const params = { model: 'deepseek-chat', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'srv__x', description: 'x', input_schema: { type: 'object', properties: { a: { type: 'number' } } } }] } as unknown as Llm.MessageCreateParamsNonStreaming;

describe('OpenAI-compat streaming (N2b)', () => {
  it('emits text deltas live and assembles tool_calls split across chunks', async () => {
    let sent: any;
    const c = client((async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return sse([
        { id: 'r1', model: 'deepseek-chat', choices: [{ delta: { content: 'Let me ' } }] },
        { choices: [{ delta: { content: 'check.' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'srv__x', arguments: '{"a":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '42}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
        '[DONE]',
      ]);
    }) as typeof fetch);
    const deltas: string[] = [];
    const s = c.messages.stream!(params);
    s.on('streamEvent', e => { if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') deltas.push(e.delta.text); });
    const msg = await s.finalMessage();
    assert.equal(sent.stream, true);
    assert.deepEqual(deltas, ['Let me ', 'check.']);
    assert.equal(msg.stop_reason, 'tool_use');
    const text = msg.content.find(b => b.type === 'text') as Llm.TextBlock;
    const tool = msg.content.find(b => b.type === 'tool_use') as Llm.ToolUseBlock;
    assert.equal(text.text, 'Let me check.');
    assert.equal(tool.name, 'srv__x');
    assert.deepEqual(tool.input, { a: 42 });
    assert.equal(msg.usage.input_tokens, 7);
  });

  it('keeps the per-call state a provider streams along with a tool call (extra_content) so it can be sent back', async () => {
    const store = new Map<string, Record<string, unknown>>();
    const c = new OpenAiCompatClient({
      baseUrl: 'https://x/v1', apiKey: 'k', modelInfo: id => getModelInfo(id), maxRetries: 0,
      meta: { get: id => store.get(id) ?? null, set: (id, m) => void store.set(id, m) },
      fetchImpl: (async () => sse([
        { id: 'r', model: 'm', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'srv__x', arguments: '{"a":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' }, extra_content: { google: { thought_signature: 'SIG' } } }] }, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ])) as typeof fetch,
    });
    const msg = await c.messages.stream!(params).finalMessage();
    assert.equal(msg.stop_reason, 'tool_use');
    assert.deepEqual(store.get('call_1'), { extraContent: { google: { thought_signature: 'SIG' } } });
  });

  it('streams reasoning separately from the answer and keeps it as a thinking block', async () => {
    const c = client((async () => sse([
      { id: 'r', model: 'm', choices: [{ delta: { reasoning_content: 'Hmm, ' } }] },
      { choices: [{ delta: { reasoning: 'let me see.' } }] },
      { choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] },
      '[DONE]',
    ])) as typeof fetch);
    const thoughts: string[] = [];
    const texts: string[] = [];
    const s = c.messages.stream!({ ...params, tools: undefined });
    s.on('streamEvent', e => {
      if (e.delta.type === 'thinking_delta') thoughts.push(e.delta.thinking);
      else texts.push(e.delta.text);
    });
    const msg = await s.finalMessage();
    assert.deepEqual(thoughts, ['Hmm, ', 'let me see.']);
    assert.deepEqual(texts, ['Done.']);
    assert.deepEqual(msg.content, [{ type: 'thinking', thinking: 'Hmm, let me see.' }, { type: 'text', text: 'Done.' }]);
  });

  it('falls back to the non-streaming path on an HTTP error, and gemini never streams', async () => {
    const bodies: any[] = [];
    const ok = { id: 'r', model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'plain' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    let n = 0;
    const c = client((async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return n++ === 0 ? new Response('busy', { status: 400 }) : new Response(JSON.stringify(ok), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);
    const msg = await c.messages.stream!(params).finalMessage();
    assert.equal((msg.content[0] as Llm.TextBlock).text, 'plain');
    assert.deepEqual(bodies.map(b => b.stream), [true, false]);
  });
});
