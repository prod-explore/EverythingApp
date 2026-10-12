import type Database from 'better-sqlite3';
import type { ProviderId } from './providers/registry.js';

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export type UsageRange = 'today' | '7d' | '30d' | 'month' | 'all';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
}

export interface UsageReport {
  range: UsageRange;
  from: string | null;
  to: string;
  totals: UsageTotals;
  byProvider: Array<UsageTotals & { provider: string }>;
  byModel: Array<UsageTotals & { provider: string; model: string }>;
  byConversation: Array<UsageTotals & { conversationId: string | null; title: string | null }>;
  byDay: Array<{ day: string; calls: number; tokens: number }>;
}

const AGG_COLUMNS = `
  COALESCE(SUM(input_tokens), 0)      AS inputTokens,
  COALESCE(SUM(output_tokens), 0)     AS outputTokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
  COUNT(*)                            AS calls`;

/** Start of `range` as a UTC instant, where "a day" is a day in the caller's timezone (tzOffsetMin = minutes east of UTC). */
export function rangeStart(range: UsageRange, now: Date, tzOffsetMin: number): Date | null {
  if (range === 'all') return null;
  const local = new Date(now.getTime() + tzOffsetMin * 60_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  let startLocalMs: number;
  if (range === 'today') startLocalMs = Date.UTC(y, m, d);
  else if (range === '7d') startLocalMs = Date.UTC(y, m, d - 6);
  else if (range === '30d') startLocalMs = Date.UTC(y, m, d - 29);
  else startLocalMs = Date.UTC(y, m, 1);
  return new Date(startLocalMs - tzOffsetMin * 60_000);
}

function clampOffset(n: number): number {
  return Number.isFinite(n) ? Math.max(-840, Math.min(840, Math.trunc(n))) : 0;
}

/**
 * Persistent, per-call token log. One row per API response; queryable by provider / model / conversation / day.
 * The app keeps no prices — money is the gateway's business (MindGate), the app only counts tokens.
 */
export class UsageLedger {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(entry: { conversationId: string | null; provider: ProviderId; model: string; usage: UsageLike }): void {
    this.db
      .prepare(
        `INSERT INTO usage_log (ts, conversation_id, provider, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now().toISOString(),
        entry.conversationId,
        entry.provider,
        entry.model,
        entry.usage.input_tokens,
        entry.usage.output_tokens,
        entry.usage.cache_creation_input_tokens ?? 0,
        entry.usage.cache_read_input_tokens ?? 0,
      );
  }

  /** Short string for the header: "12.3k tokens today". */
  headline(tzOffsetMin = -this.now().getTimezoneOffset()): string {
    const from = rangeStart('today', this.now(), tzOffsetMin)!;
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS t FROM usage_log WHERE ts >= ?`)
      .get(from.toISOString()) as { t: number };
    const t = row.t;
    const text = t >= 1_000_000 ? `${(t / 1_000_000).toFixed(1)}M` : t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
    return `${text} tokens today`;
  }

  report(range: UsageRange, tzOffsetMinRaw = 0): UsageReport {
    const tz = clampOffset(tzOffsetMinRaw);
    const now = this.now();
    const start = rangeStart(range, now, tz);
    const fromIso = start ? start.toISOString() : '';
    const where = 'WHERE ts >= @from';
    const args = { from: fromIso };

    const totals = this.db.prepare(`SELECT ${AGG_COLUMNS} FROM usage_log ${where}`).get(args) as UsageTotals;
    const byProvider = this.db
      .prepare(`SELECT provider, ${AGG_COLUMNS} FROM usage_log ${where} GROUP BY provider ORDER BY inputTokens + outputTokens DESC`)
      .all(args) as UsageReport['byProvider'];
    const byModel = this.db
      .prepare(`SELECT provider, model, ${AGG_COLUMNS} FROM usage_log ${where} GROUP BY provider, model ORDER BY inputTokens + outputTokens DESC`)
      .all(args) as UsageReport['byModel'];
    // No column in AGG_COLUMNS or `ts` exists on `conversations`, so the join needs no qualification.
    const byConversation = this.db
      .prepare(
        `SELECT usage_log.conversation_id AS conversationId, conversations.title AS title, ${AGG_COLUMNS}
         FROM usage_log LEFT JOIN conversations ON conversations.id = usage_log.conversation_id
         ${where}
         GROUP BY usage_log.conversation_id ORDER BY inputTokens + outputTokens DESC LIMIT 25`,
      )
      .all(args) as UsageReport['byConversation'];
    const byDay = this.db
      .prepare(
        `SELECT substr(datetime(ts, @mod), 1, 10) AS day,
                COUNT(*) AS calls,
                COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens
         FROM usage_log ${where} GROUP BY day ORDER BY day ASC`,
      )
      .all({ ...args, mod: `${tz >= 0 ? '+' : '-'}${Math.abs(tz)} minutes` }) as UsageReport['byDay'];

    return { range, from: start ? start.toISOString() : null, to: now.toISOString(), totals, byProvider, byModel, byConversation, byDay };
  }
}
