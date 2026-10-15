import { useCallback, useEffect, useRef, useState } from 'react';
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
        if (!cancelled && list.length > 0) setSelectedId(list[0].id);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Runs once; refresh() is stable.
  }, []);

  // The one place that guarantees a conversation is open. Deleting the last
  // chat, a first run and a deleted project all just leave the list empty;
  // this effect reacts, and the in-flight ref makes sure it spawns exactly one.
  const spawning = useRef(false);
  useEffect(() => {
    if (loading) return;
    if (conversations.length === 0) {
      if (spawning.current) return;
      spawning.current = true;
      apiCreateConversation({ title: 'New conversation' })
        .then(async ({ id }) => {
          await refresh();
          setSelectedId(id);
        })
        .catch(() => {})
        .finally(() => {
          spawning.current = false;
        });
    } else if (!selectedId || !conversations.some(c => c.id === selectedId)) {
      setSelectedId(conversations[0].id);
    }
  }, [loading, conversations, selectedId, refresh]);

  const createConversation = useCallback(async (title?: string, projectId?: string, ghost?: boolean) => {
    const { id } = await apiCreateConversation({ title, projectId, ghost });
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
      await refresh();
    },
    [refresh],
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
