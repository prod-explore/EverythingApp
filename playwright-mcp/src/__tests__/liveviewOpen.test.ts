import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from '../liveview.js';

describe('liveview normalizeUrl (human "Open browser")', () => {
  it('adds https:// to a bare host', () => {
    assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  });
  it('keeps http and https URLs', () => {
    assert.equal(normalizeUrl('http://example.com/a?b=1'), 'http://example.com/a?b=1');
    assert.equal(normalizeUrl('https://example.com'), 'https://example.com/');
  });
  it('rejects non-http schemes', () => {
    assert.equal(normalizeUrl('javascript:alert(1)'), null);
    assert.equal(normalizeUrl('file:///etc/passwd'), null);
    assert.equal(normalizeUrl('chrome://settings'), null);
  });
  it('rejects garbage', () => {
    assert.equal(normalizeUrl('http://'), null);
  });
});
