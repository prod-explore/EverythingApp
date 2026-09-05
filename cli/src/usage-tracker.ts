import type Anthropic from '@anthropic-ai/sdk';

export interface PricingRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

/**
 * Rates confirmed current as of September 2026 (Anthropic made Sonnet 5's
 * introductory pricing permanent on 2026-08-12 — no longer set to rise).
 * Prices change; this is a starting point, not a promise. Override with
 * PRICE_INPUT_PER_MTOK / PRICE_OUTPUT_PER_MTOK / PRICE_CACHE_WRITE_PER_MTOK /
 * PRICE_CACHE_READ_PER_MTOK env vars if the model or its price changes rather
 * than editing this file — check https://docs.claude.com for the current
 * table.
 */
const DEFAULT_RATES: PricingRates = {
  inputPerMTok: 2,
  outputPerMTok: 10,
  cacheWritePerMTok: 2.5,
  cacheReadPerMTok: 0.2,
};

export function loadRates(env: NodeJS.ProcessEnv = process.env): PricingRates {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    inputPerMTok: num('PRICE_INPUT_PER_MTOK', DEFAULT_RATES.inputPerMTok),
    outputPerMTok: num('PRICE_OUTPUT_PER_MTOK', DEFAULT_RATES.outputPerMTok),
    cacheWritePerMTok: num('PRICE_CACHE_WRITE_PER_MTOK', DEFAULT_RATES.cacheWritePerMTok),
    cacheReadPerMTok: num('PRICE_CACHE_READ_PER_MTOK', DEFAULT_RATES.cacheReadPerMTok),
  };
}

function costOf(usage: Anthropic.Usage, rates: PricingRates): number {
  return (
    (usage.input_tokens / 1_000_000) * rates.inputPerMTok +
    (usage.output_tokens / 1_000_000) * rates.outputPerMTok +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * rates.cacheWritePerMTok +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * rates.cacheReadPerMTok
  );
}

/** Running totals for the session — printed after each turn and available on demand via /usage. */
export class UsageTracker {
  private totalInput = 0;
  private totalOutput = 0;
  private totalCacheWrite = 0;
  private totalCacheRead = 0;
  private totalCostUsd = 0;

  constructor(private readonly rates: PricingRates = loadRates()) {}

  /** Records one API response's usage; returns that single call's cost for immediate feedback. */
  record(usage: Anthropic.Usage): number {
    this.totalInput += usage.input_tokens;
    this.totalOutput += usage.output_tokens;
    this.totalCacheWrite += usage.cache_creation_input_tokens ?? 0;
    this.totalCacheRead += usage.cache_read_input_tokens ?? 0;
    const cost = costOf(usage, this.rates);
    this.totalCostUsd += cost;
    return cost;
  }

  summary(): string {
    return (
      `wejście: ${this.totalInput}, wyjście: ${this.totalOutput}, ` +
      `cache-zapis: ${this.totalCacheWrite}, cache-odczyt: ${this.totalCacheRead} tokenów — ` +
      `≈$${this.totalCostUsd.toFixed(4)} razem w tej sesji (stawki przybliżone, patrz komentarz w usage-tracker.ts)`
    );
  }
}
