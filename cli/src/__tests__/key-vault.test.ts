import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations } from '../db.js';
import { KeyVault } from '../providers/key-vault.js';

const SECRET = 'a'.repeat(32) + 'secret-for-tests';
const API_KEY = 'sk-ant-api03-SUPER-SECRET-VALUE-1234';

function freshDb() {
  const db = openDb(':memory:');
  runMigrations(db);
  return db;
}

describe('KeyVault', () => {
  it('round-trips a key and never stores it in plaintext', () => {
    const db = freshDb();
    const vault = new KeyVault(db, SECRET);
    assert.equal(vault.set('anthropic', API_KEY).last4, '1234');

    const read = vault.read('anthropic');
    assert.equal(read.status, 'ok');
    if (read.status === 'ok') assert.equal(read.key, API_KEY);

    const raw = JSON.stringify(db.prepare('SELECT * FROM provider_keys').all());
    assert.ok(!raw.includes('SUPER-SECRET'), 'plaintext key must not appear in any column');
    assert.ok(!raw.includes(Buffer.from(API_KEY).toString('base64')), 'a bare base64 of the key must not appear either');
  });

  it('uses a fresh salt and IV on every write (same key → different ciphertext)', () => {
    const db = freshDb();
    const vault = new KeyVault(db, SECRET);
    vault.set('anthropic', API_KEY);
    const a = db.prepare('SELECT ciphertext, iv, salt FROM provider_keys').get();
    vault.set('anthropic', API_KEY);
    const b = db.prepare('SELECT ciphertext, iv, salt FROM provider_keys').get();
    assert.notDeepEqual(a, b);
  });

  it('cannot be opened with a different secret', () => {
    const db = freshDb();
    new KeyVault(db, SECRET).set('gemini', 'AIzaSy-test-key-0000');
    const other = new KeyVault(db, 'b'.repeat(40));
    const read = other.read('gemini');
    assert.equal(read.status, 'undecryptable');
    if (read.status === 'undecryptable') assert.equal(read.last4, '0000');
  });

  it("binds ciphertext to its provider: copying anthropic's row over gemini's must not decrypt", () => {
    const db = freshDb();
    const vault = new KeyVault(db, SECRET);
    vault.set('anthropic', API_KEY);
    db.prepare(
      `INSERT INTO provider_keys (provider, salt, iv, tag, ciphertext, last4)
       SELECT 'gemini', salt, iv, tag, ciphertext, last4 FROM provider_keys WHERE provider = 'anthropic'`,
    ).run();
    assert.equal(vault.read('gemini').status, 'undecryptable');
    assert.equal(vault.read('anthropic').status, 'ok');
  });

  it('detects tampering with the ciphertext', () => {
    const db = freshDb();
    const vault = new KeyVault(db, SECRET);
    vault.set('deepseek', 'sk-deepseek-abcdef');
    const row = db.prepare('SELECT ciphertext FROM provider_keys').get() as { ciphertext: string };
    const bytes = Buffer.from(row.ciphertext, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    db.prepare('UPDATE provider_keys SET ciphertext = ?').run(bytes.toString('base64'));
    assert.equal(vault.read('deepseek').status, 'undecryptable');
  });

  it('is disabled (and refuses writes) without a long-enough secret, but still reports key presence', () => {
    const db = freshDb();
    new KeyVault(db, SECRET).set('anthropic', API_KEY);

    for (const bad of [undefined, '', 'too-short']) {
      const vault = new KeyVault(db, bad);
      assert.equal(vault.enabled, false);
      assert.match(vault.disabledReason ?? '', /KEY_VAULT_SECRET/);
      assert.throws(() => vault.set('gemini', 'AIza-something'), /KEY_VAULT_SECRET/);
      assert.deepEqual(vault.hasKey('anthropic'), { present: true, last4: '1234' });
    }
  });

  it('overwrites and deletes', () => {
    const db = freshDb();
    const vault = new KeyVault(db, SECRET);
    vault.set('anthropic', 'first-key-aaaa');
    vault.set('anthropic', 'second-key-bbbb');
    const read = vault.read('anthropic');
    assert.ok(read.status === 'ok' && read.key === 'second-key-bbbb' && read.last4 === 'bbbb');
    assert.equal(vault.delete('anthropic'), true);
    assert.equal(vault.read('anthropic').status, 'empty');
    assert.equal(vault.delete('anthropic'), false);
  });
});
