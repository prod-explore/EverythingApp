import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './db.js';

/**
 * Model tiers: the app (and the orchestrator agent) pick a TIER, never a raw model id, so cost policy lives in
 * one place. `free` is the default for workers and background calls; Claude is a manual / explicit escalation.
 */
export const TIERS = ['free', 'cheap', 'standard', 'strong'] as const;
export type Tier = (typeof TIERS)[number];

export const DEFAULT_TIER_MODELS: Record<Tier, string> = {
  free: 'gemini-3.5-flash-lite',
  cheap: 'claude-haiku-4-5-20251001',
  standard: 'claude-sonnet-5',
  strong: 'claude-opus-5',
};

const SETTING_KEY = 'tier_models';

export const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v);
export const tierRank = (t: Tier): number => TIERS.indexOf(t);

/** Stored overrides merged over the defaults (a corrupt setting falls back to defaults rather than breaking chats). */
export function tierModels(db: Database.Database): Record<Tier, string> {
  const out = { ...DEFAULT_TIER_MODELS };
  const raw = getSetting(db, SETTING_KEY);
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const t of TIERS) if (typeof parsed[t] === 'string' && parsed[t]) out[t] = parsed[t] as string;
  } catch { /* keep defaults */ }
  return out;
}

export function setTierModels(db: Database.Database, patch: Partial<Record<Tier, string>>): Record<Tier, string> {
  const next = { ...tierModels(db) };
  for (const t of TIERS) if (patch[t]) next[t] = patch[t]!;
  setSetting(db, SETTING_KEY, JSON.stringify(next));
  return next;
}

/** Which tier a model belongs to (first match, cheapest tier first); null when it isn't mapped to any tier. */
export function tierOfModel(modelId: string, map: Record<Tier, string>): Tier | null {
  return TIERS.find(t => map[t] === modelId) ?? null;
}

export interface TierResolution {
  model: string;
  tier: Tier;
  /** Set when the requested tier had no usable model and the next one up was used instead. */
  fellBackFrom?: Tier;
}

/**
 * Concrete model for a tier. If `free` has no usable model (e.g. no Gemini key yet) it may step up ONE tier to
 * `cheap`; nothing ever silently escalates further than that — the caller gets null and must say so.
 */
export function resolveTier(tier: Tier, map: Record<Tier, string>, available: (modelId: string) => boolean): TierResolution | null {
  if (available(map[tier])) return { model: map[tier], tier };
  if (tier === 'free' && available(map.cheap)) return { model: map.cheap, tier: 'cheap', fellBackFrom: 'free' };
  return null;
}

/** Model for brand-new chats: free tier if usable, else cheap, else null (caller falls back to its configured default). */
export function defaultChatModel(map: Record<Tier, string>, available: (modelId: string) => boolean): string | null {
  return resolveTier('free', map, available)?.model ?? null;
}
