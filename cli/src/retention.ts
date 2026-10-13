import type Database from 'better-sqlite3';

/**
 * How long bookkeeping rows are kept. Conversations and messages are the user's own data and are never touched here;
 * the three tables below only grow with use and have no value after a while:
 *
 *   usage_log        per-call token counts (the Usage tab asks for at most "all", but a year back is plenty)
 *   approval_audit   who approved what, with the tool arguments
 *   tool_call_meta   provider-specific replay state for old tool calls (e.g. Gemini thought signatures) — only the
 *                    current turn needs it, so a chat that was idle for a year starts a clean turn anyway
 *
 * RETENTION_MONTHS: whole months, default 12; 0 (or "off"/"forever") keeps everything.
 */

export const DEFAULT_RETENTION_MONTHS = 12;

export function retentionMonths(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env['RETENTION_MONTHS'] ?? '').trim().toLowerCase();
  if (raw === '') return DEFAULT_RETENTION_MONTHS;
  if (raw === 'off' || raw === 'forever') return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 1200 ? n : DEFAULT_RETENTION_MONTHS;
}

export interface PruneResult { usage: number; audit: number; toolMeta: number }

export function pruneHistory(db: Database.Database, months: number, now: Date = new Date()): PruneResult {
  if (!(months > 0)) return { usage: 0, audit: 0, toolMeta: 0 };
  const cut = new Date(now.getTime());
  cut.setUTCMonth(cut.getUTCMonth() - months);
  const iso = cut.toISOString(); // usage_log.ts is written with toISOString()
  const sqlite = iso.slice(0, 19).replace('T', ' '); // the other tables use SQLite's datetime('now')
  return db.transaction(() => ({
    usage: db.prepare(`DELETE FROM usage_log WHERE ts < ?`).run(iso).changes,
    audit: db.prepare(`DELETE FROM approval_audit WHERE created_at < ?`).run(sqlite).changes,
    toolMeta: db.prepare(`DELETE FROM tool_call_meta WHERE created_at < ?`).run(sqlite).changes,
  }))();
}
