import type { CompatFlavor } from './openai-compat.js';

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
  /** Accepts `reasoning_effort` (low | medium | high). Sent only when the provider reports it or the user switched it on. */
  supportsEffort?: boolean;
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
  /** Keep retrying busy/overloaded errors (429/5xx/network) for this many minutes; null = the classic two retries. For peak hours. */
  retryMin: number | null;
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
export function listCatalog(): ModelInfo[] {
  return [...snapshot.models.values()];
}

/** A model nobody told us about (old conversation, typo, provider removed): conservative defaults, never throws. */
function fallbackInfo(id: string): ModelInfo {
  const parsed = parseModelId(id);
  const upstream = parsed?.upstream ?? id;
  return {
    id,
    provider: parsed?.slug ?? 'unknown',
    upstream,
    label: upstream,
    kind: 'chat',
    tags: [],
    description: '',
    supportsImages: false,
  };
}

export function getModelInfo(modelId: string): ModelInfo {
  return snapshot.models.get(modelId) ?? fallbackInfo(modelId);
}

/** False for a model that can't call tools — the app is an agent framework, so such a model is not offered anywhere. */
export const supportsTools = (info: Pick<ModelInfo, 'toolSchemaMode'>): boolean => info.toolSchemaMode !== 'none';

/** True when `modelId` is a model in the catalog (enabled or not). */
export function isCatalogModel(modelId: string): boolean {
  return snapshot.models.has(modelId);
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
  /** Suggested patience (see ProviderRecord) — a preset only pre-fills these like every other field. */
  retryMin: number | null;
  /** Rough shape of a valid key, used only to catch obvious paste mistakes in the UI — never for security. */
  keyHint: string;
}

/**
 * Convenience only: a preset pre-fills the same form every provider goes through. MindGate is listed first because
 * it is meant to be the hub, but nothing downstream treats it differently from any other entry.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { slug: 'mindgate', label: 'MindGate', baseUrl: 'https://mindgate.futumore.pl/v1', baseUrlEnv: 'MINDGATE_BASE_URL', flavor: 'mindgate', keyOptional: false, concurrency: 1, retryMin: null, keyHint: 'mg-…' },
  { slug: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', baseUrlEnv: 'GEMINI_BASE_URL', flavor: 'gemini', keyOptional: false, concurrency: null, retryMin: 720, keyHint: 'AIza…' },
  { slug: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', baseUrlEnv: 'DEEPSEEK_BASE_URL', flavor: 'deepseek', keyOptional: false, concurrency: null, retryMin: null, keyHint: 'sk-…' },
  { slug: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', flavor: 'generic', keyOptional: false, concurrency: null, retryMin: null, keyHint: 'sk-or-…' },
];

export function findPreset(slug: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.slug === slug);
}

export function presetBaseUrl(preset: ProviderPreset, env: NodeJS.ProcessEnv = process.env): string {
  return (preset.baseUrlEnv ? env[preset.baseUrlEnv] : undefined) || preset.baseUrl;
}
