import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { UsageTracker, loadRates } from '../usage-tracker.js';

const rates = { inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.2 };

function usage(partial: Partial<Anthropic.Usage>): Anthropic.Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    server_tool_use: null,
    service_tier: null,
    ...partial,
  } as Anthropic.Usage;
}

describe('UsageTracker', () => {
  it('computes cost for a plain input/output call at the given rates', () => {
    const tracker = new UsageTracker(rates);
    // 1M input tokens ($2) + 1M output tokens ($10) = $12
    const cost = tracker.record(usage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }));
    assert.equal(cost, 12);
  });

  it('accounts for cache write and cache read at their own rates', () => {
    const tracker = new UsageTracker(rates);
    const cost = tracker.record(
      usage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }),
    );
    assert.equal(cost, 2.5 + 0.2);
  });

  it('accumulates totals across multiple record() calls', () => {
    const tracker = new UsageTracker(rates);
    tracker.record(usage({ input_tokens: 1_000_000 })); // $2
    tracker.record(usage({ output_tokens: 1_000_000 })); // $10
    assert.match(tracker.summary(), /12\.0000/);
  });

  it('loadRates falls back to defaults when env vars are absent/invalid', () => {
    const r = loadRates({});
    assert.equal(r.inputPerMTok, 2);
    assert.equal(r.outputPerMTok, 10);
  });

  it('loadRates honors overrides from env vars', () => {
    const r = loadRates({ PRICE_INPUT_PER_MTOK: '5', PRICE_OUTPUT_PER_MTOK: 'not-a-number' });
    assert.equal(r.inputPerMTok, 5);
    assert.equal(r.outputPerMTok, 10); // invalid override ignored, default kept
  });
});
