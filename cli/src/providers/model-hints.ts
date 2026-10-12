import type { CompatFlavor } from './openai-compat.js';
import type { ModelKind, Pricing, ToolSchemaMode } from './registry.js';

/**
 * Optional defaults for models we happen to know — NOT a catalog. What a provider's `/models` endpoint reports
 * (and what the user sets in Settings) always wins over a hint; a model without a hint works fine, it is just
 * unpriced and untagged. Hints are keyed by dialect + upstream id, so they only ever apply to a provider that
 * really is that service.
 *
 * Prices are per-token list prices as last checked 2026-09-18. Gemini and DeepSeek figures come from secondary
 * sources and have conflicting numbers floating around — treat them as approximate and override with
 * MODEL_PRICING_JSON if the provider's own pricing page says otherwise.
 */
export interface ModelHint {
  flavor: CompatFlavor;
  /** Upstream model id (without the `@provider/` prefix). */
  id: string;
  label: string;
  kind?: ModelKind;
  tags?: string[];
  description?: string;
  pricing?: Pricing | null;
  supportsImages?: boolean;
  minOutputTokens?: number;
  toolSchemaMode?: ToolSchemaMode;
}

const FREE: Pricing = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

export const MODEL_HINTS: readonly ModelHint[] = [
  {
    flavor: 'gemini',
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite (free tier)',
    tags: ['free', 'fast', 'vision'],
    description: 'Fast general-purpose model on the Gemini free tier. Rate-limited at peak hours; not for customer data.',
    // Free of charge on the Gemini API free tier. With billing enabled the list price is $0.30 in / $2.50 out per 1M —
    // override via MODEL_PRICING_JSON if you run it on a paid project.
    pricing: FREE,
    supportsImages: true,
    minOutputTokens: 16000,
  },
  {
    flavor: 'gemini',
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    tags: ['fast', 'vision'],
    description: 'Stronger and faster Gemini for everyday work; paid.',
    pricing: { input: 0.75, output: 3.75, cacheWrite: 0.75, cacheRead: 0.075 },
    supportsImages: true,
    minOutputTokens: 16000,
  },
  {
    flavor: 'gemini',
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro',
    tags: ['smart', 'reasoning', 'coder', 'vision'],
    description: 'Strongest Gemini; use for hard reasoning and larger code changes; paid.',
    pricing: { input: 2, output: 12, cacheWrite: 2, cacheRead: 0.2 },
    supportsImages: true,
    minOutputTokens: 16000,
  },
  {
    flavor: 'deepseek',
    id: 'deepseek-chat',
    label: 'DeepSeek Chat',
    tags: ['cheap'],
    description: 'Very cheap general chat model; text only.',
    pricing: { input: 0.28, output: 0.42, cacheWrite: 0.28, cacheRead: 0.028 },
    supportsImages: false,
  },
  {
    flavor: 'deepseek',
    id: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner',
    tags: ['cheap', 'reasoning'],
    description: 'Cheap reasoning model; slow, text only.',
    pricing: { input: 0.28, output: 0.42, cacheWrite: 0.28, cacheRead: 0.028 },
    supportsImages: false,
    minOutputTokens: 16000,
  },
  {
    flavor: 'mindgate',
    id: 'flash',
    label: 'MindGate Flash (Qwen 2.5 3B)',
    tags: ['free', 'local'],
    description: 'Tiny local model on the Pi/PC: titles, summaries, trivial tasks. Weak at tool calls.',
    pricing: FREE,
    // A 3B model breaks on nested tool schemas (audit 2026-09-29: Ollama 400 "can't find closing '}'").
    toolSchemaMode: 'flat',
  },
  {
    flavor: 'mindgate',
    id: 'chat',
    label: 'MindGate Chat (Phi-4 14B)',
    tags: ['free', 'local'],
    description: 'Local general chat model.',
    pricing: FREE,
  },
  {
    flavor: 'mindgate',
    id: 'coding-fast',
    label: 'MindGate Coding Fast (Qwen 2.5 Coder 7B)',
    tags: ['free', 'local', 'coder'],
    description: 'Local coding model for small edits.',
    pricing: FREE,
  },
  {
    flavor: 'mindgate',
    id: 'reasoning',
    label: 'MindGate Reasoning (QwQ 32B)',
    tags: ['free', 'local', 'reasoning'],
    description: 'Local reasoning model; slow.',
    pricing: FREE,
  },
];

export function findHint(flavor: CompatFlavor, upstreamId: string): ModelHint | undefined {
  return MODEL_HINTS.find(h => h.flavor === flavor && h.id === upstreamId);
}

export function hintsFor(flavor: CompatFlavor): ModelHint[] {
  return MODEL_HINTS.filter(h => h.flavor === flavor);
}
