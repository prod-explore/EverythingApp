import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatElementTable, type RawElement } from '../observe.js';

describe('formatElementTable', () => {
  it('returns a placeholder for an empty element list', () => {
    assert.equal(formatElementTable([]), '(no interactive elements found on this page)');
  });

  it('formats one element per line with its ref, role/tag, and label', () => {
    const elements: RawElement[] = [
      { ref: 1, tag: 'button', role: null, label: 'Delete Account' },
      { ref: 2, tag: 'a', role: 'link', label: 'Home', href: 'https://example.com/' },
    ];
    const table = formatElementTable(elements);
    assert.equal(
      table,
      '[1] button: "Delete Account"\n[2] link: "Home" → https://example.com/',
    );
  });

  it('prefers role over tag when both are present', () => {
    const elements: RawElement[] = [{ ref: 5, tag: 'div', role: 'button', label: 'Submit' }];
    assert.match(formatElementTable(elements), /^\[5\] button: "Submit"$/);
  });
});
