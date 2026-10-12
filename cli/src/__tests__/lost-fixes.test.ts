import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { openDb, runMigrations } from '../db.js';
import { seedBuiltinCatalog } from './catalog-fixture.js';
import { OpenAiCompatClient, recoverJsonToolCalls } from '../providers/openai-compat.js';
import { getModelInfo } from '../providers/registry.js';
import { ProviderRouter, UnknownModelError } from '../providers/router.js';
import { withModelIdentity } from '../providers/identity.js';

const known = (n: string) => (n === 'srv__x' ? 'srv__x' : undefined);

describe('recoverJsonToolCalls', () => {
  it('accepts a bare object, a fenced object and an array', () => {
    assert.deepEqual(recoverJsonToolCalls('{"name":"srv__x","arguments":{"a":1}}', known), [{ name: 'srv__x', arguments: { a: 1 } }]);
    assert.deepEqual(recoverJsonToolCalls('```json\n{"name":"srv__x","parameters":{"a":2}}\n```', known), [{ name: 'srv__x', arguments: { a: 2 } }]);
    assert.equal(recoverJsonToolCalls('[{"name":"srv__x","arguments":"{\\"a\\":3}"},{"name":"srv__x","arguments":{}}]', known)?.length, 2);
  });
  it('rejects unknown tools, broken JSON, prose and oversized batches', () => {
    assert.equal(recoverJsonToolCalls('{"name":"nope","arguments":{}}', known), null);
    assert.equal(recoverJsonToolCalls('{"name":"srv__x","arguments":{', known), null);
    assert.equal(recoverJsonToolCalls('Sure, I will call {"name":"srv__x"}', known), null);
    assert.equal(recoverJsonToolCalls(JSON.stringify(Array.from({ length: 9 }, () => ({ name: 'srv__x', arguments: {} }))), known), null);
    assert.equal(recoverJsonToolCalls('{"answer": 42}', known), null);
  });
});

const params = { model: 'flash', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'srv__x', description: 'x', input_schema: { type: 'object', properties: { a: { type: 'number' } } } }] } as unknown as Anthropic.MessageCreateParamsNonStreaming;
const mk = (fetchImpl: typeof fetch, flavor: 'mindgate' | 'deepseek' = 'mindgate') =>
  new OpenAiCompatClient({ flavor, baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl, modelInfo: id => getModelInfo(id, {}), meta: { get: () => null, set: () => {} }, maxRetries: 0 });
const json = (content: string) => new Response(JSON.stringify({ id: 'r', model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const sse = (parts: string[]) => {
  const body = parts.map(p => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new TextEncoder().encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

describe('MindGate text tool calls', () => {
  it('turns a JSON-text reply into a tool_use (non-streaming)', async () => {
    const msg = await mk((async () => json('```json\n{"name":"srv__x","arguments":{"a":5}}\n```')) as typeof fetch).messages.create(params);
    assert.equal(msg.stop_reason, 'tool_use');
    assert.equal(msg.content.some(b => b.type === 'text'), false);
    const tool = msg.content.find(b => b.type === 'tool_use') as Anthropic.ToolUseBlock;
    assert.deepEqual(tool.input, { a: 5 });
  });
  it('does not touch the same reply for other flavors', async () => {
    const msg = await mk((async () => json('{"name":"srv__x","arguments":{}}')) as typeof fetch, 'deepseek').messages.create(params);
    assert.equal(msg.stop_reason, 'end_turn');
  });
  it('streaming: a recovered call never leaks raw JSON into the chat', async () => {
    const deltas: string[] = [];
    const s = mk((async () => sse(['{"name":"srv_', '_x","arguments":{"a":1}}'])) as typeof fetch).messages.stream!(params);
    s.on('streamEvent', e => { if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') deltas.push(e.delta.text); });
    const msg = await s.finalMessage();
    assert.equal(msg.stop_reason, 'tool_use');
    assert.deepEqual(deltas, []);
  });
  it('streaming: held JSON that is NOT a call is released at the end; normal text streams live', async () => {
    const held: string[] = [];
    const s1 = mk((async () => sse(['{"answer":', ' 42}'])) as typeof fetch).messages.stream!(params);
    s1.on('streamEvent', e => { if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') held.push(e.delta.text); });
    await s1.finalMessage();
    assert.deepEqual(held, ['{"answer": 42}']);
    const live: string[] = [];
    const s2 = mk((async () => sse(['Hello ', 'there'])) as typeof fetch).messages.stream!(params);
    s2.on('streamEvent', e => { if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') live.push(e.delta.text); });
    await s2.finalMessage();
    assert.deepEqual(live, ['Hello ', 'there']);
  });
});

describe('unknown model ids', () => {
  it('router.clientFor throws a readable error', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const router = new ProviderRouter({ db, env: {} });
    assert.throws(() => router.clientFor('google/gemini-2.0-flash-lite'), (e: Error) => e instanceof UnknownModelError && /Unknown model "google\/gemini-2\.0-flash-lite"/.test(e.message));
  });
});

describe('model identity', () => {
  it('appends the real model label and provider', () => {
    seedBuiltinCatalog();
    const out = withModelIdentity('Base prompt.', '@gemini/gemini-3.5-flash-lite', {});
    assert.match(out, /^Base prompt\.\n\n/);
    assert.match(out, /Gemini/);
    assert.match(out, /gemini-3\.5-flash-lite/);
    assert.match(out, /Google Gemini/);
  });
});
