import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractToken } from '../server.js';

describe('extractToken', () => {
  it('reads the key from a Bearer header', () => {
    assert.equal(extractToken({ headers: { authorization: 'Bearer abc123' } }), 'abc123');
  });

  it('ignores other schemes and a missing header', () => {
    assert.equal(extractToken({ headers: { authorization: 'Basic abc123' } }), undefined);
    assert.equal(extractToken({ headers: {} }), undefined);
  });

  it('never takes the key from the URL', () => {
    const req = { headers: {}, query: { token: 'abc123' } } as unknown as Parameters<typeof extractToken>[0];
    assert.equal(extractToken(req), undefined);
  });
});
