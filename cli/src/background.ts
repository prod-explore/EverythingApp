import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import type { LlmClient } from './anthropic-loop.js';
import { resolveTier, tierModels } from './tiers.js';
import type { ProviderRouter } from './providers/router.js';
import type { ProviderId } from './providers/registry.js';

/**
 * Housekeeping LLM calls (chat titles, the daily digest) never touch the paid chat model: they run on the
 * `free` tier and, if that has no usable model, quietly don't run — callers keep their plain fallback.
 */
export interface BackgroundModel {
  model: string;
  provider: ProviderId;
  client: LlmClient;
}

export function backgroundModel(db: Database.Database, router: ProviderRouter): BackgroundModel | null {
  const map = tierModels(db);
  const usable = (id: string) => { try { router.clientFor(id); return true; } catch { return false; } };
  // Strictly `free`: housekeeping must not silently spend on the cheap tier either.
  const r = resolveTier('free', map, usable);
  if (!r || r.fellBackFrom) return null;
  const { provider, client } = router.clientFor(r.model);
  return { model: r.model, provider, client: client as LlmClient };
}

const textOf = (m: Anthropic.Message): string =>
  m.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join(' ').trim();

/** "Fix the login redirect bug" → a ≤6-word title; null when the model gave nothing usable. */
export async function generateTitle(
  bg: BackgroundModel,
  userText: string,
  assistantText: string,
  onUsage?: (u: Anthropic.Usage) => void,
): Promise<string | null> {
  const res = await bg.client.messages.create({
    model: bg.model,
    max_tokens: 40,
    system: 'Write a title of at most 6 words for this chat. Reply with the title only — no quotes, no trailing punctuation.',
    messages: [{ role: 'user', content: `User: ${userText.slice(0, 600)}\n\nAssistant: ${assistantText.slice(0, 600)}` }],
  });
  onUsage?.(res.usage);
  const t = textOf(res).split('\n')[0]!.replace(/^["'“”*#\s]+|["'“”*.\s]+$/g, '').slice(0, 60);
  return t.length >= 2 ? t : null;
}
