import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { withHistoryCache } from '../anthropic-loop.js';

describe('withHistoryCache', () => {
  it('marks the last block of the last message and leaves the input untouched', () => {
    const history: Anthropic.MessageParam[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ];
    const out = withHistoryCache(history);
    const tail = (out[2]!.content as Anthropic.ContentBlockParam[])[0] as { cache_control?: unknown };
    assert.deepEqual(tail.cache_control, { type: 'ephemeral' });
    assert.equal(JSON.stringify(history).includes('cache_control'), false);
    assert.equal(out[0], history[0]);
  });

  it('converts a string message to a cached text block', () => {
    const out = withHistoryCache([{ role: 'user', content: 'hello' }]);
    assert.deepEqual(out[0]!.content, [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]);
  });

  it('is a no-op for empty history or a trailing thinking block', () => {
    assert.deepEqual(withHistoryCache([]), []);
    const h: Anthropic.MessageParam[] = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] }];
    assert.equal(withHistoryCache(h), h);
  });
});
