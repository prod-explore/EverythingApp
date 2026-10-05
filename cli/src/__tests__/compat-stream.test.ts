import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
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

function client(fetchImpl: typeof fetch, flavor: 'deepseek' | 'gemini' | 'generic' = 'deepseek') {
  return new OpenAiCompatClient({ flavor, baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl, modelInfo: id => getModelInfo(id, {}), meta: { get: () => null, set: () => {} }, maxRetries: 0 });
}

const params = { model: 'deepseek-chat', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'srv__x', description: 'x', input_schema: { type: 'object', properties: { a: { type: 'number' } } } }] } as unknown as Anthropic.MessageCreateParamsNonStreaming;

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
    const text = msg.content.find(b => b.type === 'text') as Anthropic.TextBlock;
    const tool = msg.content.find(b => b.type === 'tool_use') as Anthropic.ToolUseBlock;
    assert.equal(text.text, 'Let me check.');
    assert.equal(tool.name, 'srv__x');
    assert.deepEqual(tool.input, { a: 42 });
    assert.equal(msg.usage.input_tokens, 7);
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
    assert.equal((msg.content[0] as Anthropic.TextBlock).text, 'plain');
    assert.deepEqual(bodies.map(b => b.stream), [true, false]);

    const gBodies: any[] = [];
    const g = client((async (_u: string, init: RequestInit) => { gBodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify(ok), { status: 200 }); }) as typeof fetch, 'gemini');
    await g.messages.stream!({ ...params, model: 'gemini-3.8-flash' }).finalMessage();
    assert.deepEqual(gBodies.map(b => b.stream), [false]);
  });
});
