import type { CompatFlavor } from './openai-compat.js';
import { findHint } from './model-hints.js';

/**
 * What the rest of the app knows about providers and models.
 *
 * Providers are all the same kind of thing: a row with a base URL, a key and a dialect (`flavor`).
 * MindGate, Gemini, OpenRouter, a LAN vLLM — no provider is special-cased outside the adapter. Models are
 * identified everywhere as `@<provider>/<upstream-id>`; the catalog behind them lives in SQLite
 * (see catalog.ts) and is mirrored here as a read-only snapshot so that `getModelInfo()` stays a plain
 * synchronous function for the ledger, the identity line and the adapter.
 */

/** A provider's slug: `[a-z0-9-]`, unique, the `@slug/` part of every model id. */
export type ProviderId = string;

export const MODEL_KINDS = ['chat', 'image', 'tts', 'stt', 'embedding'] as const;
/** What an endpoint does. Only `chat` is wired up today; the field exists so voice/image models can be added without reshaping anything. */
export type ModelKind = (typeof MODEL_KINDS)[number];
export const isModelKind = (v: unknown): v is ModelKind => typeof v === 'string' && (MODEL_KINDS as readonly string[]).includes(v);

export type ToolSchemaMode = 'full' | 'flat' | 'none';

/** USD per million tokens. */
export interface Pricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface ModelInfo {
  /** Canonical id: `@<provider>/<upstream>`. */
  id: string;
  provider: ProviderId;
  /** The id the upstream API knows. */
  upstream: string;
  label: string;
  kind: ModelKind;
  /** Free-form usage labels (`free`, `coder`, `reasoning`, `vision`, …). `free` also gates agent spawning, see agents.ts. */
  tags: string[];
  /** One line for the orchestrator's model list. */
  description: string;
  /** null = we don't know this model's price; the ledger records the call with cost 0 and flags it as unpriced. */
  pricing: Pricing | null;
  supportsImages: boolean;
  /**
   * Floor for max_tokens. Reasoning models spend the output budget on thinking first, so the loop's default
   * 4096 can be eaten entirely before a single visible token — the request "succeeds" with an empty answer.
   */
  minOutputTokens?: number;
  /**
   * How tool JSON schemas are sent:
   *  - 'full' (default): as the MCP server declared them.
   *  - 'flat': nested object/array parameters become JSON-encoded strings (decoded again on the way back) and
   *    combinators are dropped — for small local models that cannot reliably emit nested JSON.
   *  - 'none': no tools are sent; the model can only chat.
   */
  toolSchemaMode?: ToolSchemaMode;
  contextLength?: number;
  /** Reported by a gateway that manages sleeping nodes (e.g. MindGate with WOL). */
  status?: 'online' | 'asleep' | 'waking';
  /** false = switched off in Settings; kept in the catalog so it can be re-enabled. Default true. */
  enabled?: boolean;
}

export interface ProviderRecord {
  slug: ProviderId;
  label: string;
  /** Base URL of the chat-completions API (no trailing slash). */
  baseUrl: string;
  /** Local servers often need no key. */
  keyOptional: boolean;
  /** Dialect quirks the adapter applies (see openai-compat.ts); `generic` = plain OpenAI-compatible. */
  flavor: CompatFlavor;
  enabled: boolean;
  /** Concurrent model calls for agent workers; null = default (3). Local inference: 1. */
  concurrency: number | null;
  /** Row name in the key vault (`gemini`, or `custom:<slug>` for providers created before the unification). */
  keyRef: string;
}

// ─── Model ids ───────────────────────────────────────────────────────────────

const MODEL_ID_RE = /^@([a-z0-9][a-z0-9-]{0,31})\/(.+)$/;

/** `@slug/upstream-model` → { slug, upstream } */
export function parseModelId(modelId: string): { slug: string; upstream: string } | null {
  const m = MODEL_ID_RE.exec(modelId);
  return m ? { slug: m[1]!, upstream: m[2]! } : null;
}

export function formatModelId(slug: string, upstream: string): string {
  return `@${slug}/${upstream}`;
}

const LEGACY_LOCAL_ALIASES = ['flash', 'chat', 'reasoning', 'coding-fast', 'coding-hard', 'extreme'];

/**
 * Ids stored before the provider unification were bare ("gemini-3.5-flash-lite", "flash") and the provider was
 * guessed from the name. Old conversations, runs and settings still carry them, so every lookup passes through
 * here: a bare id maps to its historical provider's slug, anything else is returned unchanged.
 */
export function normalizeModelId(raw: string): string {
  if (!raw || MODEL_ID_RE.test(raw)) return raw;
  const id = raw.toLowerCase();
  if (id.startsWith('gemini')) return formatModelId('gemini', raw);
  if (id.startsWith('deepseek')) return formatModelId('deepseek', raw);
  if (LEGACY_LOCAL_ALIASES.includes(id) || id.startsWith('mindgate') || id.startsWith('pipeline:')) return formatModelId('mindgate', raw);
  return raw;
}

// ─── Snapshot of the catalog (kept in sync by ModelCatalog) ──────────────────

interface Snapshot {
  providers: Map<string, ProviderRecord>;
  models: Map<string, ModelInfo>;
}

let snapshot: Snapshot = { providers: new Map(), models: new Map() };

export function setCatalogSnapshot(next: Snapshot): void {
  snapshot = next;
}

export function getProvider(slug: string): ProviderRecord | undefined {
  return snapshot.providers.get(slug);
}

export function providerLabel(slug: string): string {
  return snapshot.providers.get(slug)?.label ?? slug;
}

/** Every model in the catalog (enabled or not), in the order providers/models were added. */
export function listCatalog(env: NodeJS.ProcessEnv = process.env): ModelInfo[] {
  return [...snapshot.models.values()].map(m => withPricingOverride(m, env));
}

/**
 * MODEL_PRICING_JSON='{"@gemini/gemini-3.8-flash":{"input":0.3,"output":0.5}}' — per-model price overrides
 * (USD per million tokens) without a code change; keys may be the canonical id or the bare upstream id.
 * Unspecified cacheWrite defaults to `input`, cacheRead to input/10. Also how you price a model nobody priced.
 */
function loadOverrides(env: NodeJS.ProcessEnv): Record<string, Partial<Pricing>> {
  const raw = env['MODEL_PRICING_JSON'];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Partial<Pricing>>) : {};
  } catch {
    console.warn('[pricing] MODEL_PRICING_JSON is not valid JSON — ignoring it.');
    return {};
  }
}

function withPricingOverride(base: ModelInfo, env: NodeJS.ProcessEnv): ModelInfo {
  const overrides = loadOverrides(env);
  const override = overrides[base.id] ?? overrides[base.upstream];
  if (!override || typeof override.input !== 'number' || typeof override.output !== 'number') return base;
  return {
    ...base,
    pricing: {
      input: override.input,
      output: override.output,
      cacheWrite: override.cacheWrite ?? override.input,
      cacheRead: override.cacheRead ?? override.input / 10,
    },
  };
}

/** A model nobody told us about (old conversation, typo, provider removed): conservative defaults, never throws. */
function fallbackInfo(id: string): ModelInfo {
  const parsed = parseModelId(id);
  const upstream = parsed?.upstream ?? id;
  const flavor = parsed ? snapshot.providers.get(parsed.slug)?.flavor : undefined;
  const hint = flavor ? findHint(flavor, upstream) : undefined;
  return {
    id,
    provider: parsed?.slug ?? 'unknown',
    upstream,
    label: hint?.label ?? upstream,
    kind: hint?.kind ?? 'chat',
    tags: hint?.tags ? [...hint.tags] : [],
    description: hint?.description ?? '',
    pricing: hint?.pricing ?? null,
    supportsImages: hint?.supportsImages ?? false,
    minOutputTokens: hint?.minOutputTokens,
    toolSchemaMode: hint?.toolSchemaMode,
  };
}

export function getModelInfo(modelId: string, env: NodeJS.ProcessEnv = process.env): ModelInfo {
  const id = normalizeModelId(modelId);
  return withPricingOverride(snapshot.models.get(id) ?? fallbackInfo(id), env);
}

/** True when `modelId` is a model in the catalog (enabled or not). */
export function isCatalogModel(modelId: string): boolean {
  return snapshot.models.has(normalizeModelId(modelId));
}

// ─── Provider presets (starting points for "Add provider") ───────────────────

export interface ProviderPreset {
  slug: string;
  label: string;
  baseUrl: string;
  /** Env var that overrides baseUrl (proxies, tests). */
  baseUrlEnv?: string;
  flavor: CompatFlavor;
  keyOptional: boolean;
  concurrency: number | null;
  /** Rough shape of a valid key, used only to catch obvious paste mistakes in the UI — never for security. */
  keyHint: string;
}

/**
 * Convenience only: a preset pre-fills the same form every provider goes through. MindGate is listed first because
 * it is meant to be the hub, but nothing downstream treats it differently from any other entry.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { slug: 'mindgate', label: 'MindGate', baseUrl: 'https://mindgate.futumore.pl/v1', baseUrlEnv: 'MINDGATE_BASE_URL', flavor: 'mindgate', keyOptional: false, concurrency: 1, keyHint: 'mg-…' },
  { slug: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', baseUrlEnv: 'GEMINI_BASE_URL', flavor: 'gemini', keyOptional: false, concurrency: null, keyHint: 'AIza…' },
  { slug: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', baseUrlEnv: 'DEEPSEEK_BASE_URL', flavor: 'deepseek', keyOptional: false, concurrency: null, keyHint: 'sk-…' },
  { slug: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', flavor: 'generic', keyOptional: false, concurrency: null, keyHint: 'sk-or-…' },
];

export function findPreset(slug: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.slug === slug);
}

export function presetBaseUrl(preset: ProviderPreset, env: NodeJS.ProcessEnv = process.env): string {
  return (preset.baseUrlEnv ? env[preset.baseUrlEnv] : undefined) || preset.baseUrl;
}
