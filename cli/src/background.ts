import type * as Llm from './llm-types.js';
import type Database from 'better-sqlite3';
import type { LlmClient } from './llm-loop.js';
import { resolveSlot } from './slots.js';
import type { ProviderRouter } from './providers/router.js';
import type { ProviderId } from './providers/registry.js';

/**
 * Housekeeping LLM calls (chat titles, the daily digest) never touch the chat model: they run on the `helper` slot
 * (automatically a `free`-tagged model unless the user picked one) and, if there is no usable model, quietly don't
 * run — callers keep their plain fallback.
 */
export interface BackgroundModel {
  model: string;
  provider: ProviderId;
  client: LlmClient;
}

export function backgroundModel(db: Database.Database, router: ProviderRouter): BackgroundModel | null {
  const model = resolveSlot(db, 'helper', router.chatCandidates(), id => router.isAvailable(id));
  if (!model) return null;
  const { provider, client } = router.clientFor(model);
  return { model, provider, client: client as LlmClient };
}

const textOf = (m: Llm.Message): string =>
  m.content.filter((b): b is Llm.TextBlock => b.type === 'text').map(b => b.text).join(' ').trim();

/** "Fix the login redirect bug" → a ≤6-word title; null when the model gave nothing usable. */
export async function generateTitle(
  bg: BackgroundModel,
  userText: string,
  assistantText: string,
  onUsage?: (u: Llm.Usage) => void,
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
