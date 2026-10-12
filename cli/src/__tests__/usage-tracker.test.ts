import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { costOf } from '../usage-tracker.js';

const rates = { inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.2 };

describe('costOf', () => {
  it('prices plain input/output at the given rates', () => {
    // 1M input ($2) + 1M output ($10)
    assert.equal(costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, rates), 12);
  });

  it('prices cache write and cache read at their own rates; null counts as zero', () => {
    assert.equal(costOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }, rates), 2.5 + 0.2);
    assert.equal(costOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null }, rates), 0);
  });
});
