import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as Llm from '../llm-types.js';
import { OpenAiCompatClient, ProviderHttpError } from '../providers/openai-compat.js';
import { getModelInfo } from '../providers/registry.js';

function client(handler: (url: string, n: number) => Response) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return handler(String(url), calls.length);
  }) as typeof fetch;
  const c = new OpenAiCompatClient({
    baseUrl: 'https://gw.example/v1', apiKey: 'mg-SECRET-KEY', fetchImpl: impl, sleep: async () => {},
    meta: { get: () => null, set: () => {} }, modelInfo: getModelInfo,
  });
  return { c, calls };
}

const ask = (c: OpenAiCompatClient) =>
  c.messages.create({ model: 'flash', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] } as Llm.MessageCreateParamsNonStreaming);

describe('gateway adapter', () => {
  it('listModels returns data[] (or models[]) and sends the key', async () => {
    const { c, calls } = client(() => new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] })));
    assert.deepEqual(await c.listModels(), [{ id: 'a' }, { id: 'b' }]);
    assert.equal(calls[0], 'https://gw.example/v1/models');
    const alt = client(() => new Response(JSON.stringify({ models: [{ id: 'x' }] })));
    assert.deepEqual(await alt.c.listModels(), [{ id: 'x' }]);
    assert.deepEqual(await client(() => new Response('{}')).c.listModels(), []);
  });

  it('listModels errors never contain the key', async () => {
    const { c } = client(() => new Response('denied for mg-SECRET-KEY', { status: 401 }));
    await assert.rejects(() => c.listModels(), (e: Error) => e instanceof ProviderHttpError && !e.message.includes('mg-SECRET-KEY'));
  });

  it('budget_exhausted fails fast with the gateway\'s message — no retries', async () => {
    const { c, calls } = client(() => new Response(JSON.stringify({ error: { code: 'budget_exhausted', message: 'Monthly budget used up' } }), { status: 429 }));
    await assert.rejects(() => ask(c), /Monthly budget used up/);
    assert.equal(calls.length, 1);
  });

  it('a plain rate limit is still retried', async () => {
    const { c, calls } = client((_u, n) => n < 3
      ? new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }), { status: 429 })
      : new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })));
    const reply = await ask(c);
    assert.equal((reply.content[0] as { text: string }).text, 'ok');
    assert.equal(calls.length, 3);
  });
});
