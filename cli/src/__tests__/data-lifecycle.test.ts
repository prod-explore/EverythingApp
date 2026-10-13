import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_SCHEMA_VERSION, appendMessage, createConversation, getConversation, openDb, runMigrations, schemaVersion } from '../db.js';
import { DEFAULT_RETENTION_MONTHS, pruneHistory, retentionMonths } from '../retention.js';
import { backupDatabase, inspectDatabase, main, pruneBackups, restoreDatabase } from '../tools/db-backup.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'ea-lifecycle-')); }

function seededDb(file: string) {
  const db = openDb(file);
  runMigrations(db);
  const id = createConversation(db, { title: 'keep me' }).id;
  appendMessage(db, id, 'user', 'hello');
  appendMessage(db, id, 'assistant', [{ type: 'text', text: 'hi' }]);
  return { db, id };
}

describe('backup / verify / restore', () => {
  it('writes a consistent, private copy while the database is open and being written to', async () => {
    const dir = tmp();
    try {
      const { db, id } = seededDb(join(dir, 'ea.db'));
      for (let i = 0; i < 200; i++) appendMessage(db, id, 'user', `m${i}`); // WAL has content that the .db file alone does not
      const info = await backupDatabase(join(dir, 'ea.db'), join(dir, 'b', 'copy.db'));
      assert.equal(info.conversations, 1);
      assert.equal(info.messages, 202);
      assert.equal(info.schemaVersion, LATEST_SCHEMA_VERSION);
      assert.equal(statSync(join(dir, 'b', 'copy.db')).mode & 0o077, 0, 'owner-only permissions');
      // One self-contained file: no leftovers from the temporary copy, no WAL companions.
      assert.deepEqual(readdirSync(join(dir, 'b')), ['copy.db']);
      inspectDatabase(join(dir, 'b', 'copy.db'));
      assert.deepEqual(readdirSync(join(dir, 'b')), ['copy.db'], 'inspecting a backup leaves nothing behind either');
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('verify rejects a damaged file and a foreign database', async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'junk.db'), 'this is not sqlite at all, just text '.repeat(50));
      assert.throws(() => inspectDatabase(join(dir, 'junk.db')));
      const other = new Database(join(dir, 'other.db'));
      other.exec('CREATE TABLE t (x)');
      other.close();
      assert.throws(() => inspectDatabase(join(dir, 'other.db')), /not an EverythingApp database/);
      assert.throws(() => inspectDatabase(join(dir, 'missing.db')), /No such file/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('restore swaps the database, keeps the old one aside and drops stale WAL files', async () => {
    const dir = tmp();
    try {
      const target = join(dir, 'ea.db');
      const { db, id } = seededDb(target);
      await backupDatabase(target, join(dir, 'good.db'));
      appendMessage(db, id, 'user', 'written after the backup');
      createConversation(db, { title: 'created after the backup' });
      db.close();

      const r = await restoreDatabase(join(dir, 'good.db'), target);
      assert.equal(r.restored.messages, 2);
      assert.ok(r.safetyCopy && existsSync(r.safetyCopy), 'previous database kept');
      assert.equal(inspectDatabase(r.safetyCopy!).conversations, 2);

      const reopened = openDb(target);
      runMigrations(reopened);
      assert.equal(getConversation(reopened, id)!.title, 'keep me');
      assert.equal((reopened.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n, 1);
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('restore refuses a backup from a newer build and leaves the database alone', async () => {
    const dir = tmp();
    try {
      const target = join(dir, 'ea.db');
      const { db } = seededDb(target);
      await backupDatabase(target, join(dir, 'future.db'));
      const f = new Database(join(dir, 'future.db'));
      f.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 5}`);
      f.close();
      await assert.rejects(restoreDatabase(join(dir, 'future.db'), target), /newer EverythingApp/);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n, 1);
      assert.deepEqual(readdirSync(dir).filter(f2 => f2.includes('before-restore')), []);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps only the newest N backups, by name', () => {
    const dir = tmp();
    try {
      for (const d of ['20260101-000000', '20260102-000000', '20260103-000000', '20260104-000000']) writeFileSync(join(dir, `everythingapp-${d}.db`), 'x');
      writeFileSync(join(dir, 'notes.txt'), 'unrelated');
      writeFileSync(join(dir, 'everythingapp-20260101-000000.db-wal'), 'old leftovers');
      const removed = pruneBackups(dir, 2);
      assert.deepEqual(removed, ['everythingapp-20260101-000000.db', 'everythingapp-20260102-000000.db']);
      assert.deepEqual(readdirSync(dir).sort(), ['everythingapp-20260103-000000.db', 'everythingapp-20260104-000000.db', 'notes.txt']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the command line: restore without --yes only explains; with it, it restores', async () => {
    const dir = tmp();
    const saved = process.env['EVERYTHINGAPP_DB_PATH'];
    try {
      const target = join(dir, 'ea.db');
      process.env['EVERYTHINGAPP_DB_PATH'] = target;
      const { db } = seededDb(target);
      db.close();
      const lines: string[] = [];
      assert.equal(await main(['backup', join(dir, 'b.db')], s => lines.push(s)), 0);
      assert.match(lines.join('\n'), /Backup written/);
      lines.length = 0;
      assert.equal(await main(['restore', join(dir, 'b.db')], s => lines.push(s)), 2);
      assert.match(lines.join('\n'), /Stop the server first/);
      assert.equal(await main(['restore', join(dir, 'b.db'), '--yes'], s => lines.push(s)), 0);
      assert.equal(await main(['verify', join(dir, 'b.db')], s => lines.push(s)), 0);
      assert.equal(await main(['backup', '--keep', '0'], s => lines.push(s)), 1);

      // `--keep N` is a flag with a value, not a file name: the default location is used and old backups are pruned.
      const backups = join(dir, 'backups');
      mkdirSync(backups, { recursive: true });
      for (const d of ['20260101-000000', '20260102-000000', '20260103-000000']) writeFileSync(join(backups, `everythingapp-${d}.db`), 'x');
      lines.length = 0;
      assert.equal(await main(['backup', '--keep', '2'], s => lines.push(s)), 0, lines.join('\n'));
      assert.match(lines.join('\n'), /Removed \d+ older backup/);
      assert.equal(readdirSync(backups).filter(f => f.endsWith('.db')).length, 2);
      assert.ok(!existsSync(join(process.cwd(), '2')), 'no file called "2" was created');
      assert.equal(await main(['nonsense'], s => lines.push(s)), 2);
    } finally {
      if (saved === undefined) delete process.env['EVERYTHINGAPP_DB_PATH']; else process.env['EVERYTHINGAPP_DB_PATH'] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('schema upgrades protect the data', () => {
  it('a file database that holds chats gets a pre-migration copy; running again does not make another', () => {
    const dir = tmp();
    try {
      const file = join(dir, 'old.db');
      const db = openDb(file);
      runMigrations(db);
      createConversation(db, { title: 'precious' });
      // Pretend this database was written by a build before versioned migrations.
      db.exec(`DROP TRIGGER conversations_ghost_immutable; DROP TRIGGER projects_ghost_immutable;`);
      db.pragma('user_version = 0');
      runMigrations(db);
      assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
      const copy = `${file}.pre-v0.bak`;
      assert.ok(existsSync(copy), 'safety copy written');
      assert.equal(inspectDatabase(copy).conversations, 1);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a fresh, empty database needs no copy', () => {
    const dir = tmp();
    try {
      const file = join(dir, 'new.db');
      const db = openDb(file);
      runMigrations(db);
      db.close();
      assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.bak')), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('retention', () => {
  it('parses RETENTION_MONTHS', () => {
    assert.equal(retentionMonths({}), DEFAULT_RETENTION_MONTHS);
    assert.equal(retentionMonths({ RETENTION_MONTHS: '6' }), 6);
    assert.equal(retentionMonths({ RETENTION_MONTHS: '0' }), 0);
    assert.equal(retentionMonths({ RETENTION_MONTHS: 'forever' }), 0);
    assert.equal(retentionMonths({ RETENTION_MONTHS: 'off' }), 0);
    assert.equal(retentionMonths({ RETENTION_MONTHS: '-3' }), DEFAULT_RETENTION_MONTHS);
    assert.equal(retentionMonths({ RETENTION_MONTHS: 'abc' }), DEFAULT_RETENTION_MONTHS);
    assert.equal(retentionMonths({ RETENTION_MONTHS: '2.5' }), DEFAULT_RETENTION_MONTHS);
  });

  it('removes only old usage, audit and replay rows — never conversations — in both timestamp formats', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const now = new Date('2026-10-13T12:00:00Z');
    const conv = createConversation(db, { title: 'old but mine' }).id;
    const usage = db.prepare(`INSERT INTO usage_log (ts, provider, model) VALUES (?, 'p', 'm')`);
    usage.run('2025-09-01T00:00:00.000Z'); // older than 12 months
    usage.run('2025-10-14T00:00:00.000Z'); // just inside
    usage.run('2026-10-01T00:00:00.000Z');
    const audit = db.prepare(`INSERT INTO approval_audit (action, tool_label, created_at) VALUES ('a', 't', ?)`);
    audit.run('2025-09-01 00:00:00');
    audit.run('2026-09-01 00:00:00');
    const meta = db.prepare(`INSERT INTO tool_call_meta (tool_call_id, provider, meta, created_at) VALUES (?, 'p', '{}', ?)`);
    meta.run('old', '2025-01-01 00:00:00');
    meta.run('new', '2026-10-12 00:00:00');
    db.prepare(`UPDATE conversations SET created_at = '2020-01-01 00:00:00', updated_at = '2020-01-01 00:00:00' WHERE id = ?`).run(conv);

    assert.deepEqual(pruneHistory(db, 12, now), { usage: 1, audit: 1, toolMeta: 1 });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM usage_log').get() as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM approval_audit').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT tool_call_id AS id FROM tool_call_meta').get() as { id: string }).id, 'new');
    assert.equal(getConversation(db, conv)!.title, 'old but mine');
    assert.deepEqual(pruneHistory(db, 12, now), { usage: 0, audit: 0, toolMeta: 0 }, 'idempotent');
    assert.deepEqual(pruneHistory(db, 0, now), { usage: 0, audit: 0, toolMeta: 0 }, '0 keeps everything');
  });
});
