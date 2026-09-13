import { useCallback, useEffect, useState } from 'react';
import { dismissGazetaItem, getGazetaItems, respondToGazetaItem } from '../api';
import type { GazetaItem } from '../types';

const POLL_MS = 30_000;

export function useGazeta() {
  const [items, setItems] = useState<GazetaItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { items: list } = await getGazetaItems('pending');
    setItems(list);
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    // No per-item SSE push for Gazeta (server.ts emits a bare `gazeta:new`
    // on the ACTIVE conversation's own stream, not a dedicated channel this
    // hook could subscribe to independent of which conversation is open) —
    // a light poll is the simple, correct fallback so a new item still
    // shows up within half a minute even if the current tab isn't the one
    // that triggered it.
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const respond = useCallback(
    async (id: string, response: unknown) => {
      await respondToGazetaItem(id, response);
      setItems(prev => prev.filter(i => i.id !== id));
    },
    [],
  );

  const dismiss = useCallback(async (id: string) => {
    await dismissGazetaItem(id);
    setItems(prev => prev.filter(i => i.id !== id));
  }, []);

  return { items, loading, respond, dismiss, refresh };
}
