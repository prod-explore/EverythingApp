import Database from 'better-sqlite3';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LATEST_SCHEMA_VERSION, dbPath } from '../db.js';

/**
 * Backup, verify and restore of the EverythingApp database.
 *
 *   node dist/tools/db-backup.js backup  [file] [--keep N]
 *   node dist/tools/db-backup.js verify  <file>
 *   node dist/tools/db-backup.js restore <file> --yes        (stop the server first)
 *
 * `backup` uses SQLite's online backup API, so it is safe while the server runs and the copy is consistent even in WAL
 * mode — a plain `cp` of the .db file is not. A backup holds everything: every chat (ghost chats too), the encrypted
 * provider keys and settings. Keys are encrypted with KEY_VAULT_SECRET, which is NOT in the backup: keep both, store
 * the file as carefully as the chats it contains.
 */

export interface BackupInfo { file: string; bytes: number; schemaVersion: number; conversations: number; messages: number }

export function inspectDatabase(file: string): BackupInfo {
  if (!existsSync(file)) throw new Error(`No such file: ${file}`);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const check = db.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error(`${file} is damaged (integrity_check: ${String(check)})`);
    const has = (t: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(t);
    if (!has('conversations') || !has('messages')) throw new Error(`${file} is not an EverythingApp database`);
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return {
      file,
      bytes: statSync(file).size,
      schemaVersion: db.pragma('user_version', { simple: true }) as number,
      conversations: count('conversations'),
      messages: count('messages'),
    };
  } finally {
    db.close();
  }
}

const stamp = (d = new Date()) => d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

export async function backupDatabase(source: string, dest: string): Promise<BackupInfo> {
  if (!existsSync(source)) throw new Error(`No database at ${source}`);
  if (resolve(source) === resolve(dest)) throw new Error('The backup file must differ from the database');
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  rmSync(tmp, { force: true });
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(tmp);
  } finally {
    db.close();
  }
  try {
    // The copy inherits WAL mode from the source; as a single self-contained file it must not need -wal/-shm
    // companions (opening a WAL database, even read-only, would leave them behind next to every backup).
    const copy = new Database(tmp, { fileMustExist: true });
    try { copy.pragma('journal_mode = DELETE'); } finally { copy.close(); }
    inspectDatabase(tmp); // never leave a file named like a backup that cannot be restored
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  renameSync(tmp, dest);
  chmodSync(dest, 0o600);
  return inspectDatabase(dest);
}

/** Keeps the newest `keep` files named everythingapp-*.db in `dir`; returns what it deleted. */
export function pruneBackups(dir: string, keep: number): string[] {
  if (!(keep >= 1) || !existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => /^everythingapp-\d{8}-\d{6}\.db$/.test(f)).sort(); // the stamp sorts chronologically
  const old = files.slice(0, Math.max(0, files.length - keep));
  for (const f of old) for (const suffix of ['', '-wal', '-shm']) rmSync(join(dir, f + suffix), { force: true });
  return old;
}

export async function restoreDatabase(backup: string, target: string): Promise<{ restored: BackupInfo; safetyCopy: string | null }> {
  const info = inspectDatabase(backup);
  if (info.schemaVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(`This backup comes from a newer EverythingApp (schema ${info.schemaVersion}, this build knows ${LATEST_SCHEMA_VERSION}). Update first.`);
  }
  mkdirSync(dirname(target), { recursive: true });
  // What is being replaced is kept, so a restore is never a one-way door.
  let safetyCopy: string | null = null;
  if (existsSync(target)) {
    safetyCopy = join(dirname(target), `${basename(target)}.before-restore-${stamp()}`);
    await backupDatabase(target, safetyCopy);
  }
  const staging = `${target}.restoring`;
  copyFileSync(backup, staging);
  chmodSync(staging, 0o600);
  // Stale WAL/SHM files of the old database would be replayed onto the restored one.
  rmSync(`${target}-wal`, { force: true });
  rmSync(`${target}-shm`, { force: true });
  renameSync(staging, target);
  return { restored: inspectDatabase(target), safetyCopy };
}

function human(n: number): string {
  return n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function describe(i: BackupInfo): string {
  return `${i.file} — ${human(i.bytes)}, schema v${i.schemaVersion}, ${i.conversations} conversations, ${i.messages} messages`;
}

export async function main(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  // Positional arguments are everything that is neither a flag nor the value of a flag that takes one.
  const VALUE_FLAGS = new Set(['--keep']);
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith('--')) args.push(a);
  }
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const [cmd, fileArg] = args;
  const db = dbPath();
  try {
    if (cmd === 'backup') {
      const keepRaw = value('keep');
      const keep = keepRaw === undefined ? 0 : Number(keepRaw);
      if (keepRaw !== undefined && !(Number.isInteger(keep) && keep >= 1)) throw new Error('--keep needs a whole number ≥ 1');
      const defaultDir = join(dirname(db), 'backups');
      const dest = fileArg ?? join(defaultDir, `everythingapp-${stamp()}.db`);
      const info = await backupDatabase(db, dest);
      out(`Backup written: ${describe(info)}`);
      if (keep) {
        const removed = pruneBackups(dirname(dest), keep);
        if (removed.length) out(`Removed ${removed.length} older backup(s), keeping the newest ${keep}.`);
      }
      return 0;
    }
    if (cmd === 'verify' && fileArg) {
      out(`OK: ${describe(inspectDatabase(fileArg))}`);
      return 0;
    }
    if (cmd === 'restore' && fileArg) {
      const info = inspectDatabase(fileArg);
      if (!flag('yes')) {
        out(`This would replace ${db} with ${describe(info)}.\nStop the server first, then run it again with --yes. The current database is kept next to it as *.before-restore-*.`);
        return 2;
      }
      const r = await restoreDatabase(fileArg, db);
      out(`Restored: ${describe(r.restored)}`);
      if (r.safetyCopy) out(`The previous database was kept as ${r.safetyCopy}`);
      return 0;
    }
    out('Usage:\n  db-backup backup [file] [--keep N]\n  db-backup verify <file>\n  db-backup restore <file> --yes   (stop the server first)');
    return 2;
  } catch (err) {
    out(`Error: ${(err as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}
