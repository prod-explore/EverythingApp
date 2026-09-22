import type Database from 'better-sqlite3';
import { getProviderLimit, markProviderWarned } from './db.js';
import { costOf, type PricingRates } from './usage-tracker.js';
import { getModelInfo, type ProviderId } from './providers/registry.js';

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface SpendWarning {
  provider: ProviderId;
  monthSpendUsd: number;
  thresholdUsd: number;
}

export interface RecordResult {
  costUsd: number;
  pricingKnown: boolean;
  warning: SpendWarning | null;
}

export type UsageRange = 'today' | '7d' | '30d' | 'month' | 'all';

export interface UsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  /** Calls to models we have no price for — their cost is counted as 0, so the total is a lower bound when this is > 0. */
  unpricedCalls: number;
}

export interface UsageReport {
  range: UsageRange;
  from: string | null;
  to: string;
  totals: UsageTotals;
  byProvider: Array<UsageTotals & { provider: string }>;
  byModel: Array<UsageTotals & { provider: string; model: string }>;
  byConversation: Array<UsageTotals & { conversationId: string | null; title: string | null }>;
  byDay: Array<{ day: string; costUsd: number; calls: number; tokens: number }>;
  /** Month-to-date spend per provider next to its configured soft cap — what the warning is evaluated against. */
  monthToDate: Array<{ provider: string; costUsd: number; warnUsd: number | null }>;
}

const BATCH_DISCOUNT = 0.5;
const AGG_COLUMNS = `
  COALESCE(SUM(cost_usd), 0)          AS costUsd,
  COALESCE(SUM(input_tokens), 0)      AS inputTokens,
  COALESCE(SUM(output_tokens), 0)     AS outputTokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
  COUNT(*)                            AS calls,
  COALESCE(SUM(CASE WHEN pricing_known = 0 THEN 1 ELSE 0 END), 0) AS unpricedCalls`;

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
 * Persistent, per-call spend log. One row per billed API response, priced at
 * write time with the rates in force then — so later price changes never
 * rewrite history — and queryable by provider / model / conversation / day.
 */
export class UsageLedger {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  record(entry: {
    conversationId: string | null;
    provider: ProviderId;
    model: string;
    usage: UsageLike;
    batch?: boolean;
  }): RecordResult {
    const info = getModelInfo(entry.model, this.env);
    const pricingKnown = info.pricing !== null;
    const rates: PricingRates | null = info.pricing && {
      inputPerMTok: info.pricing.input,
      outputPerMTok: info.pricing.output,
      cacheWritePerMTok: info.pricing.cacheWrite,
      cacheReadPerMTok: info.pricing.cacheRead,
    };
    let costUsd = rates ? costOf(entry.usage, rates) : 0;
    if (entry.batch) costUsd *= BATCH_DISCOUNT;

    const ts = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO usage_log (ts, conversation_id, provider, model, input_tokens, output_tokens,
           cache_write_tokens, cache_read_tokens, cost_usd, pricing_known, batch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ts,
        entry.conversationId,
        entry.provider,
        entry.model,
        entry.usage.input_tokens,
        entry.usage.output_tokens,
        entry.usage.cache_creation_input_tokens ?? 0,
        entry.usage.cache_read_input_tokens ?? 0,
        costUsd,
        pricingKnown ? 1 : 0,
        entry.batch ? 1 : 0,
      );

    return { costUsd, pricingKnown, warning: this.checkWarning(entry.provider, ts.slice(0, 7)) };
  }

  /** UTC month, matching how usage_log.ts is stored. Fires at most once per provider per month (re-armed when the threshold is edited). */
  private checkWarning(provider: ProviderId, period: string): SpendWarning | null {
    const limit = getProviderLimit(this.db, provider);
    if (limit.warnUsdMonthly === null || limit.warnedPeriod === period) return null;
    const spend = this.monthSpend(provider, period);
    if (spend < limit.warnUsdMonthly) return null;
    markProviderWarned(this.db, provider, period);
    return { provider, monthSpendUsd: spend, thresholdUsd: limit.warnUsdMonthly };
  }

  private monthSpend(provider: string, period: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage_log WHERE provider = ? AND substr(ts, 1, 7) = ?`)
      .get(provider, period) as { s: number };
    return row.s;
  }

  /** Short string for the header: "$1.23 today". */
  headline(tzOffsetMin = -this.now().getTimezoneOffset()): string {
    const from = rangeStart('today', this.now(), tzOffsetMin)!;
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s, COALESCE(SUM(pricing_known = 0), 0) AS unpriced FROM usage_log WHERE ts >= ?`)
      .get(from.toISOString()) as { s: number; unpriced: number };
    const amount = row.s < 0.01 && row.s > 0 ? '<$0.01' : `$${row.s.toFixed(2)}`;
    return `${row.unpriced > 0 ? '≥' : ''}${amount} today`;
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
      .prepare(`SELECT provider, ${AGG_COLUMNS} FROM usage_log ${where} GROUP BY provider ORDER BY costUsd DESC`)
      .all(args) as UsageReport['byProvider'];
    const byModel = this.db
      .prepare(`SELECT provider, model, ${AGG_COLUMNS} FROM usage_log ${where} GROUP BY provider, model ORDER BY costUsd DESC`)
      .all(args) as UsageReport['byModel'];
    // No column in AGG_COLUMNS or `ts` exists on `conversations`, so the join needs no qualification.
    const byConversation = this.db
      .prepare(
        `SELECT usage_log.conversation_id AS conversationId, conversations.title AS title, ${AGG_COLUMNS}
         FROM usage_log LEFT JOIN conversations ON conversations.id = usage_log.conversation_id
         ${where}
         GROUP BY usage_log.conversation_id ORDER BY costUsd DESC LIMIT 25`,
      )
      .all(args) as UsageReport['byConversation'];
    const byDay = this.db
      .prepare(
        `SELECT substr(datetime(ts, @mod), 1, 10) AS day,
                COALESCE(SUM(cost_usd), 0) AS costUsd, COUNT(*) AS calls,
                COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens
         FROM usage_log ${where} GROUP BY day ORDER BY day ASC`,
      )
      .all({ ...args, mod: `${tz >= 0 ? '+' : '-'}${Math.abs(tz)} minutes` }) as UsageReport['byDay'];

    const period = now.toISOString().slice(0, 7);
    const providers = new Set<string>([
      ...(this.db.prepare(`SELECT DISTINCT provider FROM usage_log WHERE substr(ts, 1, 7) = ?`).all(period) as Array<{ provider: string }>).map(r => r.provider),
      ...(this.db.prepare(`SELECT provider FROM provider_limits WHERE warn_usd_monthly IS NOT NULL`).all() as Array<{ provider: string }>).map(r => r.provider),
    ]);
    const monthToDate = [...providers].map(provider => ({
      provider,
      costUsd: this.monthSpend(provider, period),
      warnUsd: getProviderLimit(this.db, provider).warnUsdMonthly,
    }));

    return { range, from: start ? start.toISOString() : null, to: now.toISOString(), totals, byProvider, byModel, byConversation, byDay, monthToDate };
  }
}
