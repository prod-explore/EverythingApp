import { useExternalStoreRuntime } from '@assistant-ui/react';
import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getMessages, killTurn, sendMessage } from '../api';
import { useSSE } from '../hooks/useSSE';
import { foldRawMessages, liveTurnToMessage } from './messages';

export function useEverythingAppRuntime(conversationId: string | null) {
  const [persisted, setPersisted] = useState<ThreadMessageLike[]>([]);
  const live = useSSE(conversationId);

  const refetch = useCallback(() => {
    if (!conversationId) {
      setPersisted([]);
      return;
    }
    getMessages(conversationId)
      .then(({ messages }) => setPersisted(foldRawMessages(messages)))
      .catch(() => {
        // Transient — the next natural refetch (conversation switch, turn
        // finishing) will pick it up. Nothing actionable to show here.
      });
  }, [conversationId]);

  // Refetch on conversation switch, and again every time a turn finishes —
  // finishedCount (not `running`) is the trigger because it changes exactly
  // once per completed turn even if two turns somehow finish back to back,
  // where a boolean could stay `false` across both and never fire the effect.
  useEffect(() => {
    refetch();
  }, [refetch, live.finishedCount]);

  const liveMessage = useMemo(() => liveTurnToMessage(live.parts), [live.parts]);
  const messages = useMemo(
    () => (liveMessage ? [...persisted, liveMessage] : persisted),
    [persisted, liveMessage],
  );

  const onNew = useCallback(
    async (message: AppendMessage) => {
      if (!conversationId) return;
      const text = message.content
        .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
        .map(c => c.text)
        .join('');
      if (!text.trim()) return;

      // Optimistic: show the user's own message immediately rather than
      // waiting on the round trip to the backend and the turn:start SSE
      // event — on a slow connection that gap is visible and looks broken.
      setPersisted(prev => [...prev, { id: `opt-${Date.now()}`, role: 'user', content: [{ type: 'text', text }] }]);

      try {
        await sendMessage(conversationId, text);
      } catch {
        // Roll back the optimistic message — a failed send with no reply
        // and no way to retry from where it left off is worse than just
        // making the user retype it.
        setPersisted(prev => prev.slice(0, -1));
      }
    },
    [conversationId],
  );

  const onCancel = useCallback(async () => {
    if (!conversationId) return;
    await killTurn(conversationId);
  }, [conversationId]);

  return useExternalStoreRuntime({
    messages,
    isRunning: live.running,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew,
    onCancel,
  });
}
