import { useCallback, useEffect, useState } from 'react';
import { compactConversation, getConversationState, patchConversationState } from '../api';
import type { ConversationStateInfo, ReasoningEffort } from '../types';
import type { LiveTurnState } from './useSSE';

/**
 * Reasoning effort, the todo list and the context meter of one chat. Loaded from the server when the chat
 * opens and after every turn; between those the live stream (useSSE) pushes changes.
 */
export function useConversationState(conversationId: string | null, live: LiveTurnState) {
  const [state, setState] = useState<ConversationStateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!conversationId) { setState(null); return; }
    getConversationState(conversationId).then(setState).catch(() => { /* the next turn refreshes it */ });
  }, [conversationId]);

  useEffect(() => { setNote(null); reload(); }, [reload, live.finishedCount, live.compactedCount]);
  useEffect(() => { if (live.convState) setState(live.convState); }, [live.convState]);
  useEffect(() => {
    if (live.context) setState(s => (s ? { ...s, context: { used: live.context!.used, limit: live.context!.limit ?? s.context.limit } } : s));
  }, [live.context]);

  const patch = useCallback(
    async (p: Parameters<typeof patchConversationState>[1]) => {
      if (!conversationId) return;
      try { setState(await patchConversationState(conversationId, p)); } catch (e) { setNote((e as Error).message); }
    },
    [conversationId],
  );

  const setEffort = useCallback((effort: ReasoningEffort | null) => patch({ effort }), [patch]);
  const clearTodos = useCallback(() => patch({ clearTodos: true }), [patch]);

  /** Returns true when something was actually summarised. */
  const compact = useCallback(async (): Promise<boolean> => {
    if (!conversationId) return false;
    setBusy(true);
    setNote(null);
    try {
      const r = await compactConversation(conversationId);
      setState(r.state);
      if (!r.compacted) setNote('Nothing to compact yet — the conversation is still short.');
      return r.compacted;
    } catch (e) {
      setNote((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [conversationId]);

  return { state, busy, note, setEffort, clearTodos, compact };
}

export type ConversationStateApi = ReturnType<typeof useConversationState>;
