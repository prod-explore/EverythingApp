import { describe, expect, it } from 'vitest';
import { summarizeResponse } from './gazetaFormat';

describe('summarizeResponse', () => {
  it.each([
    [null, ''],
    [undefined, ''],
    ['plain answer', 'plain answer'],
    [{ choice: 'Approve' }, 'Approve'],
    [{ text: 'free text' }, 'free text'],
    [{ acknowledged: true }, 'Marked handled'],
    [{ fields: { name: 'Ada', age: 36 } }, 'name: Ada, age: 36'],
  ])('%j → %j', (input, expected) => {
    expect(summarizeResponse(input)).toBe(expected);
  });

  it('falls back to JSON for a shape it does not know', () => {
    expect(summarizeResponse({ other: 1 })).toBe('{"other":1}');
    expect(summarizeResponse(42)).toBe('42');
  });

  it('prefers a choice over free text', () => {
    expect(summarizeResponse({ choice: 'A', text: 'b' })).toBe('A');
  });
});
