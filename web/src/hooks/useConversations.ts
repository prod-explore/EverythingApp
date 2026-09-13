import { useCallback, useEffect, useState } from 'react';
import {
  createConversation as apiCreateConversation,
  deleteConversation as apiDeleteConversation,
  listConversations,
  updateConversation as apiUpdateConversation,
} from '../api';
import type { ConversationSummary } from '../types';

export function useConversations() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { conversations: list } = await listConversations();
    setConversations(list);
    return list;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    refresh()
      .then(list => {
        if (cancelled) return;
        // Land on the most recently active conversation, or make a fresh
        // one if this is a first run with none yet — never show a picker
        // with no conversation open.
        if (list.length > 0) {
          setSelectedId(list[0].id);
        } else {
          apiCreateConversation({ title: 'New conversation' }).then(({ id }) => {
            if (cancelled) return;
            setSelectedId(id);
            refresh();
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Intentionally runs once — refresh() is stable (no deps) and re-running
    // this on every refresh() identity change would fight the create-if-empty logic above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createConversation = useCallback(async (title?: string) => {
    const { id } = await apiCreateConversation({ title });
    await refresh();
    setSelectedId(id);
    return id;
  }, [refresh]);

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      await apiUpdateConversation(id, { title });
      await refresh();
    },
    [refresh],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      await apiDeleteConversation(id);
      const list = await refresh();
      if (selectedId === id) {
        setSelectedId(list[0]?.id ?? null);
      }
    },
    [refresh, selectedId],
  );

  return {
    conversations,
    selectedId,
    setSelectedId,
    loading,
    createConversation,
    renameConversation,
    deleteConversation,
    refresh,
  };
}
