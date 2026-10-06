/**
 * Static knowledge about providers and models: which API dialect each speaks,
 * where it lives, and what it costs. Deliberately data, not logic — when a
 * price or model id changes, this is the only file that should need editing
 * (or set MODEL_PRICING_JSON, see below, without touching code at all).
 */

export type BuiltinProviderId = 'anthropic' | 'gemini' | 'deepseek' | 'mindgate';
/** N5: user-added OpenAI-compatible endpoints (OpenRouter, LM Studio, vLLM, Together, …). */
export type CustomProviderId = `custom:${string}`;
export type ProviderId = BuiltinProviderId | CustomProviderId;

export const PROVIDER_IDS: readonly BuiltinProviderId[] = ['anthropic', 'gemini', 'deepseek', 'mindgate'];

export function isProviderId(value: string): value is BuiltinProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export function isCustomProviderId(value: string): value is CustomProviderId {
  return value.startsWith('custom:');
}

export interface CustomModelDef {
  /** Model id as the upstream API knows it (e.g. "meta-llama/llama-4-maverick"). */
  id: string;
  label?: string;
  supportsImages?: boolean;
  toolSchemaMode?: 'full' | 'flat' | 'none';
  /** USD per million tokens; omitted = unpriced (counted as 0, flagged). */
  pricing?: { input: number; output: number } | null;
}

export interface CustomProviderDef {
  /** Slug: [a-z0-9-]; provider id is `custom:<slug>`, model ids are `@<slug>/<model>`. */
  slug: string;
  label: string;
  baseUrl: string;
  /** Local servers often need no key. */
  keyOptional: boolean;
  models: CustomModelDef[];
}

let customProviders: CustomProviderDef[] = [];

/** Kept in sync with the custom_providers table by the router. */
export function setCustomProviders(defs: CustomProviderDef[]): void {
  customProviders = defs;
}

export function getCustomProvider(slug: string): CustomProviderDef | undefined {
  return customProviders.find(p => p.slug === slug);
}

/** `@slug/upstream-model` → { slug, upstream } */
export function parseCustomModelId(modelId: string): { slug: string; upstream: string } | null {
  const m = /^@([a-z0-9-]+)\/(.+)$/.exec(modelId);
  return m ? { slug: m[1]!, upstream: m[2]! } : null;
}

export interface ProviderDef {
  id: BuiltinProviderId;
  label: string;
  /** Anthropic only: an env var that may supply the key when the vault has none (back-compat with the pre-Phase-3 .env setup). */
  envKeyFallback?: string;
  /** OpenAI-compatible providers: base URL of the chat-completions API (no trailing slash). */
  baseUrl?: string;
  /** Env var that overrides baseUrl (proxies, tests). */
  baseUrlEnv?: string;
  /** Rough shape of a valid key, used only to catch obvious paste mistakes in the UI — never for security. */
  keyHint: string;
}

export const PROVIDERS: Record<BuiltinProviderId, ProviderDef> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    envKeyFallback: 'ANTHROPIC_API_KEY',
    keyHint: 'sk-ant-…',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    baseUrlEnv: 'GEMINI_BASE_URL',
    keyHint: 'AIza…',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    keyHint: 'sk-…',
  },
  mindgate: {
    id: 'mindgate',
    label: 'MindGate (RasPi / Local)',
    baseUrl: 'https://mindgate.futumore.pl/v1',
    baseUrlEnv: 'MINDGATE_BASE_URL',
    keyHint: 'mg-…',
  },
};

/** USD per million tokens. */
export interface Pricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface ModelInfo {
  id: string;
  provider: ProviderId;
  label: string;
  /** null = we don't know this model's price; the ledger records the call with cost 0 and flags it as unpriced. */
  pricing: Pricing | null;
  supportsImages: boolean;
  /** Only Anthropic's own models can use the Anthropic-hosted web_search server tool. */
  supportsWebSearch: boolean;
  /** Only Anthropic's Batch API is wired up (see batch.ts). */
  supportsBatch: boolean;
  /**
   * Floor for max_tokens. Reasoning models spend the output budget on
   * thinking first, so the loop's default 4096 can be eaten entirely before a
   * single visible token — the request "succeeds" with an empty answer.
   */
  minOutputTokens?: number;
  /**
   * How tool JSON schemas are sent to OpenAI-compatible providers:
   *  - 'full' (default): as the MCP server declared them.
   *  - 'flat': nested object/array parameters become JSON-encoded strings (decoded again on the way
   *    back) and combinators are dropped — for small local models that cannot reliably emit nested JSON.
   *  - 'none': no tools are sent; the model can only chat.
   */
  toolSchemaMode?: 'full' | 'flat' | 'none';
  /** Hidden from pickers (kept only so old conversations still get priced correctly). */
  hidden?: boolean;
}

function anthropicPricing(input: number, output: number): Pricing {
  return { input, output, cacheWrite: input * 1.25, cacheRead: input * 0.1 };
}

/**
 * Prices are per-token list prices as last checked 2026-09-18. Anthropic's
 * are from its pricing docs; Gemini and DeepSeek figures come from secondary
 * sources and DeepSeek/Gemini 3.8 Flash in particular have conflicting
 * numbers floating around — treat those as approximate and override with
 * MODEL_PRICING_JSON if the provider's own pricing page says otherwise.
 */
const CATALOG: ModelInfo[] = [
  {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 5',
    pricing: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    supportsImages: true,
    supportsWebSearch: true,
    supportsBatch: true,
  },
  {
    id: 'claude-opus-5',
    provider: 'anthropic',
    label: 'Claude Opus 5',
    pricing: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    supportsImages: true,
    supportsWebSearch: true,
    supportsBatch: true,
    // Adaptive thinking is on by default on Opus 5 and counts against max_tokens.
    minOutputTokens: 16000,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    label: 'Claude Haiku 4.5',
    pricing: anthropicPricing(1, 5),
    supportsImages: true,
    supportsWebSearch: true,
    supportsBatch: true,
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.6',
    pricing: anthropicPricing(3, 15),
    supportsImages: true,
    supportsWebSearch: true,
    supportsBatch: true,
    hidden: true,
  },
  {
    id: 'gemini-3.5-flash-lite',
    provider: 'gemini',
    label: 'Gemini 3.5 Flash-Lite (free tier)',
    // Free of charge on the Gemini API free tier (rate-limited; not for customer data). With billing enabled the
    // list price is $0.30 in / $2.50 out per 1M — override via MODEL_PRICING_JSON if you run it on a paid project.
    pricing: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    supportsImages: true,
    supportsWebSearch: false,
    supportsBatch: false,
    minOutputTokens: 16000,
  },
  {
    id: 'gemini-3.8-flash',
    provider: 'gemini',
    label: 'Gemini 3.8 Flash',
    pricing: { input: 0.75, output: 3.75, cacheWrite: 0.75, cacheRead: 0.075 },
    supportsImages: true,
    supportsWebSearch: false,
    supportsBatch: false,
    minOutputTokens: 16000,
  },
  {
    id: 'gemini-3.1-pro-preview',
    provider: 'gemini',
    label: 'Gemini 3.1 Pro',
    pricing: { input: 2, output: 12, cacheWrite: 2, cacheRead: 0.2 },
    supportsImages: true,
    supportsWebSearch: false,
    supportsBatch: false,
    minOutputTokens: 16000,
  },
  {
    id: 'deepseek-chat',
    provider: 'deepseek',
    label: 'DeepSeek Chat',
    pricing: { input: 0.28, output: 0.42, cacheWrite: 0.28, cacheRead: 0.028 },
    supportsImages: false,
    supportsWebSearch: false,
    supportsBatch: false,
  },
  {
    id: 'deepseek-reasoner',
    provider: 'deepseek',
    label: 'DeepSeek Reasoner',
    pricing: { input: 0.28, output: 0.42, cacheWrite: 0.28, cacheRead: 0.028 },
    supportsImages: false,
    supportsWebSearch: false,
    supportsBatch: false,
    minOutputTokens: 16000,
  },
  {
    id: 'flash',
    provider: 'mindgate',
    label: 'MindGate Flash (Qwen 2.5 3B)',
    pricing: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    supportsImages: false,
    supportsWebSearch: false,
    supportsBatch: false,
    // A 3B model breaks on nested tool schemas (audit 2026-09-29: Ollama 400 "can't find closing '}'").
    toolSchemaMode: 'flat',
  },
  {
    id: 'chat',
    provider: 'mindgate',
    label: 'MindGate Chat (Phi-4 14B)',
    pricing: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    supportsImages: false,
    supportsWebSearch: false,
    supportsBatch: false,
  },
  {
    id: 'coding-fast',
    provider: 'mindgate',
    label: 'MindGate Coding Fast (Qwen 2.5 Coder 7B)',
    pricing: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    supportsImages: false,
    supportsWebSearch: false,
    supportsBatch: false,
  },
  {
    id: 'reasoning',
    provider: 'mindgate',
    label: 'MindGate Reasoning (QwQ 32B)',
    pricing: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    supportsImages: false,
    supportsWebSearch: false,
    supportsBatch: false,
  },
];

/**
 * MODEL_PRICING_JSON='{"deepseek-chat":{"input":0.3,"output":0.5}}' — per-model
 * price overrides (USD per million tokens) without a code change. Unspecified
 * cacheWrite defaults to `input`, cacheRead to input/10. Also how you price a
 * model that isn't in the catalog at all.
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

/** Best-effort provider guess for a model id that isn't in the catalog. Unknown → anthropic, matching pre-Phase-3 behaviour. */
export function guessProvider(modelId: string): BuiltinProviderId {
  const id = modelId.toLowerCase();
  if (['flash', 'chat', 'reasoning', 'coding-fast', 'coding-hard', 'extreme'].includes(id) || id.startsWith('mindgate') || id.startsWith('pipeline:')) return 'mindgate';
  if (id.startsWith('gemini')) return 'gemini';
  if (id.startsWith('deepseek')) return 'deepseek';
  return 'anthropic';
}

function customModelInfo(modelId: string): ModelInfo | null {
  const parsed = parseCustomModelId(modelId);
  if (!parsed) return null;
  const def = getCustomProvider(parsed.slug);
  const model = def?.models.find(m => m.id === parsed.upstream);
  const p = model?.pricing;
  return {
    id: modelId,
    provider: `custom:${parsed.slug}`,
    label: `${model?.label || parsed.upstream} (${def?.label ?? parsed.slug})`,
    pricing: p ? { input: p.input, output: p.output, cacheWrite: p.input, cacheRead: p.input / 10 } : null,
    supportsImages: model?.supportsImages ?? false,
    supportsWebSearch: false,
    supportsBatch: false,
    toolSchemaMode: model?.toolSchemaMode,
  };
}

export function getModelInfo(modelId: string, env: NodeJS.ProcessEnv = process.env): ModelInfo {
  const custom = customModelInfo(modelId);
  if (custom) return custom;
  const found = CATALOG.find(m => m.id === modelId);
  const provider = found?.provider ?? guessProvider(modelId);
  const base: ModelInfo = found ?? {
    id: modelId,
    provider,
    label: modelId,
    pricing: null,
    // Unknown model: assume the provider's usual capabilities rather than silently disabling features.
    supportsImages: provider !== 'deepseek',
    supportsWebSearch: provider === 'anthropic',
    supportsBatch: provider === 'anthropic',
  };

  const override = loadOverrides(env)[modelId];
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

export function listCatalog(env: NodeJS.ProcessEnv = process.env): ModelInfo[] {
  const custom = customProviders.flatMap(p => p.models.map(m => customModelInfo(`@${p.slug}/${m.id}`)!));
  return [...CATALOG.map(m => getModelInfo(m.id, env)), ...custom];
}
