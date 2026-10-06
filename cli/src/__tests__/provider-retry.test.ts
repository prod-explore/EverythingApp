import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { getModelInfo } from '../providers/registry.js';
import { OpenAiCompatClient, ProviderHttpError, retryDelayMs, type RetryInfo } from '../providers/openai-compat.js';

const ok = { choices: [{ finish_reason: 'stop', message: { content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const req = { model: 'gemini-3.5-flash-lite', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] } as Anthropic.MessageCreateParamsNonStreaming;

function scripted(steps: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | 'network'>) {
  let i = 0;
  const impl = (async () => {
    const step = steps[Math.min(i++, steps.length - 1)]!;
    if (step === 'network') throw new TypeError('fetch failed');
    return new Response(typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {}), { status: step.status, headers: step.headers });
  }) as typeof fetch;
  return { impl, calls: () => i };
}

function client(f: typeof fetch, extra: Partial<ConstructorParameters<typeof OpenAiCompatClient>[0]> = {}) {
  const sleeps: number[] = [];
  const retries: RetryInfo[] = [];
  const c = new OpenAiCompatClient({
    flavor: 'gemini',
    baseUrl: 'https://api.example.test',
    apiKey: 'k',
    meta: { get: () => null, set: () => {} },
    modelInfo: getModelInfo,
    fetchImpl: f,
    sleep: async ms => { sleeps.push(ms); },
    onRetry: r => retries.push(r),
    ...extra,
  });
  return { c, sleeps, retries };
}

describe('retryDelayMs', () => {
  it('backs off exponentially with ±20% jitter, never above the cap or below 1 s', () => {
    assert.equal(retryDelayMs(0, undefined, 300_000, () => 0.5), 1000);
    assert.equal(retryDelayMs(3, undefined, 300_000, () => 0.5), 8000);
    assert.equal(retryDelayMs(3, undefined, 300_000, () => 0), 6400);
    assert.equal(retryDelayMs(20, undefined, 300_000, () => 1), 300_000);
  });
  it('lets the server Retry-After win, still capped', () => {
    assert.equal(retryDelayMs(0, 42, 300_000), 42_000);
    assert.equal(retryDelayMs(0, 9999, 300_000), 300_000);
  });
});

describe('budgeted retry (provider peak hours)', () => {
  it('keeps retrying past the classic 2-retry limit until the provider recovers', async () => {
    const f = scripted([...Array(6).fill({ status: 429, body: 'quota' }), { status: 200, body: ok }]);
    const { c, sleeps, retries } = client(f.impl, { retryBudgetMs: 12 * 3_600_000 });
    const res = await c.messages.create(req);
    assert.equal((res.content[0] as Anthropic.TextBlock).text, 'done');
    assert.equal(f.calls(), 7);
    assert.equal(sleeps.length, 6);
    assert.ok(sleeps.every(ms => ms >= 1000 && ms <= 300_000));
    assert.deepEqual(retries.map(r => r.attempt), [1, 2, 3, 4, 5, 6]);
    assert.equal(retries[0]!.status, 429);
  });

  it('honours Retry-After', async () => {
    const f = scripted([{ status: 429, body: 'slow down', headers: { 'retry-after': '90' } }, { status: 200, body: ok }]);
    const { c, sleeps } = client(f.impl, { retryBudgetMs: 3_600_000 });
    await c.messages.create(req);
    assert.deepEqual(sleeps, [90_000]);
  });

  it('retries network errors in budget mode', async () => {
    const f = scripted(['network', 'network', { status: 200, body: ok }]);
    const { c, sleeps } = client(f.impl, { retryBudgetMs: 3_600_000 });
    await c.messages.create(req);
    assert.equal(sleeps.length, 2);
  });

  it('gives up when the budget cannot cover another wait, and says so', async () => {
    const f = scripted([{ status: 503, body: 'overloaded' }]);
    const { c } = client(f.impl, { retryBudgetMs: 2500 });
    await assert.rejects(c.messages.create(req), (e: Error) => e instanceof ProviderHttpError && e.status === 503 && /gave up/.test(e.message));
    assert.equal(f.calls(), 3);
  });

  it('never retries a non-transient error', async () => {
    const f = scripted([{ status: 400, body: 'bad request' }]);
    const { c } = client(f.impl, { retryBudgetMs: 3_600_000 });
    await assert.rejects(c.messages.create(req), (e: Error) => e instanceof ProviderHttpError && e.status === 400);
    assert.equal(f.calls(), 1);
  });

  it('the kill switch interrupts a long wait immediately', async () => {
    const f = scripted([{ status: 429, body: 'quota' }]);
    const ctl = new AbortController();
    const { c } = client(f.impl, {
      retryBudgetMs: 12 * 3_600_000,
      sleep: () => new Promise<void>(() => {}), // would wait "forever"
      onRetry: () => queueMicrotask(() => ctl.abort(new Error('killed'))),
    });
    await assert.rejects(c.messages.create(req, { signal: ctl.signal }), /killed/);
    assert.equal(f.calls(), 1);
  });

  it('without a budget, network errors and the 2-retry limit behave as before', async () => {
    const net = scripted(['network']);
    await assert.rejects(client(net.impl).c.messages.create(req), TypeError);
    assert.equal(net.calls(), 1);
    const busy = scripted([{ status: 503, body: 'x' }]);
    await assert.rejects(client(busy.impl).c.messages.create(req), ProviderHttpError);
    assert.equal(busy.calls(), 3);
  });
});
