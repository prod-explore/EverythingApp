import type Database from 'better-sqlite3';
import type * as Llm from './llm-types.js';
import type { LlmClient } from './llm-loop.js';
import { appendSummary, loadLlmHistory, setConversationState } from './db.js';
import { planCompaction, summarizeHistory, withSummary } from './context.js';

/** The history a turn starts from: the latest summary (if any) in front of everything after it. */
export function llmHistory(db: Database.Database, conversationId: string, beforeId?: number): Llm.MessageParam[] {
  const h = loadLlmHistory(db, conversationId, beforeId);
  return withSummary(h.summary, h.rows.map(r => ({ role: r.role, content: r.content })) as Llm.MessageParam[]);
}

export interface CompactResult {
  compacted: boolean;
  /** How many messages the new summary stands in for (including those an earlier summary already covered). */
  replaced: number;
}

/**
 * Replaces the older part of a conversation by a summary written by `model`. The newest user turns stay verbatim;
 * `maxTailTokens` shrinks that tail when it is itself large. The originals are kept (the UI still lists them).
 * Returns { compacted: false } when there is nothing sensible to cut.
 */
export async function compactConversation(
  db: Database.Database,
  conversationId: string,
  o: {
    llm: LlmClient;
    model: string;
    /** Leave out the message that is about to be sent. */
    beforeId?: number;
    keepTurns?: number;
    maxTailTokens?: number;
    signal?: AbortSignal;
    onUsage?: (u: Llm.Usage) => void;
  },
): Promise<CompactResult> {
  const h = loadLlmHistory(db, conversationId, o.beforeId);
  const cut = planCompaction(h.rows, { keepTurns: o.keepTurns, maxTailTokens: o.maxTailTokens });
  if (cut === null) return { compacted: false, replaced: 0 };

  const head = h.rows.slice(0, cut);
  const text = await summarizeHistory({
    llm: o.llm,
    model: o.model,
    messages: head.map(r => ({ role: r.role, content: r.content })) as Llm.MessageParam[],
    previous: h.summary,
    signal: o.signal,
    onUsage: o.onUsage,
  });
  const upTo = head[head.length - 1]!.id;
  appendSummary(db, conversationId, { text, upTo, replaced: cut });
  // The last measured prompt size described the old history.
  setConversationState(db, conversationId, { lastInputTokens: null });
  return { compacted: true, replaced: cut };
}
