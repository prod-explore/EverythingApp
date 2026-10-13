import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PushService } from '../push.js';
import { KeyVault } from '../providers/key-vault.js';
import { openDb, runMigrations, createGazetaItem, onGazetaItemCreated } from '../db.js';

const SECRET = '0123456789abcdef0123456789abcdef'; // gitleaks:allow — made-up fixture
const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'a' } });

describe('web push', () => {
  it('generates stable VAPID keys, sends, and prunes expired subscriptions', async () => {
    const db = openDb(':memory:'); runMigrations(db);
    const calls: string[] = [];
    const svc = new PushService(db, new KeyVault(db, SECRET), async (s, payload) => {
      calls.push(s.endpoint);
      if (s.endpoint.endsWith('/2')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      assert.equal(JSON.parse(payload).title, 'Deploy blocked');
    });
    const key = svc.publicKey();
    assert.ok(key && key.length > 40);
    assert.equal(svc.publicKey(), key, 'keys persist');
    svc.subscribe(sub(1)); svc.subscribe(sub(2)); svc.subscribe(sub(1));
    assert.equal(svc.count(), 2);
    assert.equal(await svc.notify({ title: 'Deploy blocked', body: 'x' }), 1);
    assert.equal(svc.count(), 1, '410 pruned');
  });

  it('is off without a vault secret and rejects bad subscriptions', async () => {
    const db = openDb(':memory:'); runMigrations(db);
    const svc = new PushService(db, new KeyVault(db, ''), async () => { throw new Error('must not send'); });
    assert.equal(svc.publicKey(), null);
    assert.equal(await svc.notify({ title: 't' }), 0);
    assert.throws(() => svc.subscribe({ endpoint: 'http://insecure', keys: { p256dh: 'p', auth: 'a' } }));
  });

  it('listener fires for created gazeta items with the urgent flag', () => {
    const db = openDb(':memory:'); runMigrations(db);
    const seen: boolean[] = [];
    const off = onGazetaItemCreated(i => seen.push(i.urgent));
    createGazetaItem(db, { type: 'report', title: 'a' });
    createGazetaItem(db, { type: 'report', title: 'b', urgent: true });
    off();
    createGazetaItem(db, { type: 'report', title: 'c', urgent: true });
    assert.deepEqual(seen, [false, true]);
  });
});
