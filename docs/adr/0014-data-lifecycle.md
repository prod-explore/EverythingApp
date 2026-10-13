# ADR 0014 — Schema versions, backups and retention

Status: accepted (phase H)

## Context

The database grew by guarded `ALTER TABLE … ADD COLUMN` statements that run on every start. That works until a change needs to run once (a data fix, a trigger, a rename), and it cannot tell a database written by a *newer* build from an old one. There was no supported way to take a consistent backup of a SQLite file in WAL mode (a plain copy of the `.db` file can miss committed data), and usage, approval-audit and replay rows grew without bound.

## Decision

1. **Versioned migrations** (`MIGRATIONS` in `db.ts`, stamped in `PRAGMA user_version`). The existing idempotent statements stay as the baseline; every new schema change is a numbered entry that runs exactly once, in order, in its own transaction. Entries that shipped are never edited. A database stamped with a *higher* version than the build knows is refused with a message instead of being misread. Before the first pending migration on a file database that already holds data, a copy is written next to it (`<db>.pre-v<N>.bak`, via `VACUUM INTO`).
2. **Backup / verify / restore** (`node dist/tools/db-backup.js`, `deploy/backup.sh` for the compose stack). `backup` uses SQLite's online backup API, so it is safe while the server runs; the result is integrity-checked before it gets its final name, is owner-only, and `--keep N` prunes older ones. `restore` refuses damaged files, files that are not EverythingApp databases and backups from a newer schema, keeps the replaced database as `*.before-restore-*`, removes stale WAL/SHM files and needs `--yes` and a stopped server. Provider keys in a backup are encrypted with `KEY_VAULT_SECRET`, which is not in it.
3. **Retention** (`RETENTION_MONTHS`, default 12, `0` = forever): once a day, `usage_log`, `approval_audit` and `tool_call_meta` rows older than that are deleted. Conversations, messages, grants and inbox items are never touched. Replay state (`tool_call_meta`) is only needed for the current turn, so a chat idle for a year simply starts a clean turn.

## Consequences

- Upgrading an existing database creates one `*.pre-v0.bak` copy (the size of the database) the first time; delete it once the new version has run fine.
- Restoring onto a different machine needs the same `KEY_VAULT_SECRET`, otherwise provider keys must be entered again.
- Usage statistics older than the retention window disappear from the Usage tab by design; set `RETENTION_MONTHS=0` to keep them.
