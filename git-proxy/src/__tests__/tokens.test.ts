import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findGrant, hashToken, TokenStore } from '../tokens.js';

describe('TokenStore', () => {
  it('mints opaque tokens, verifies them and stores only the hash', () => {
    const s = new TokenStore();
    const { token, expiresAt } = s.mint('p1', [{ owner: 'Acme', repo: 'App.git', pushMode: 'ask' }], 60);
    assert.match(token, /^gpx_[A-Za-z0-9_-]{40,}$/);
    assert.ok(Date.parse(expiresAt) > Date.now());
    const b = s.verify(token);
    assert.equal(b?.projectId, 'p1');
    assert.equal(b?.repos[0]!.repo, 'App');
    const keys = [...(s as any).byHash.keys()];
    assert.deepEqual(keys, [hashToken(token)]);
    assert.ok(!keys.includes(token));
    assert.equal(s.verify('gpx_nope'), null);
  });

  it('expires tokens', () => {
    let now = 1_000_000;
    const s = new TokenStore(() => now);
    const { token } = s.mint('p1', [{ owner: 'a', repo: 'b', pushMode: 'allow' }], 30);
    now += 29_000;
    assert.ok(s.verify(token));
    now += 1_000;
    assert.equal(s.verify(token), null);
    assert.equal(s.size, 0);
  });

  it('revokes by token and by project; sweep drops expired', () => {
    let now = 0;
    const s = new TokenStore(() => now);
    const a = s.mint('p1', [{ owner: 'a', repo: 'b', pushMode: 'ask' }], 10).token;
    s.mint('p1', [{ owner: 'a', repo: 'b', pushMode: 'ask' }], 100);
    s.mint('p2', [{ owner: 'a', repo: 'b', pushMode: 'ask' }], 100);
    assert.equal(s.revoke(a), true);
    assert.equal(s.revoke(a), false);
    assert.equal(s.revokeProject('p1'), 1);
    s.mint('p3', [{ owner: 'a', repo: 'b', pushMode: 'ask' }], 1);
    now = 5_000;
    assert.equal(s.sweep(), 1);
    assert.equal(s.size, 1);
  });

  it('findGrant is case-insensitive and ignores .git', () => {
    const s = new TokenStore();
    const b = s.verify(s.mint('p', [{ owner: 'Acme', repo: 'App', pushMode: 'deny' }], 60).token)!;
    assert.equal(findGrant(b, 'acme', 'app.git')?.pushMode, 'deny');
    assert.equal(findGrant(b, 'acme', 'other'), undefined);
    assert.equal(findGrant(b, 'evil', 'app'), undefined);
  });
});
