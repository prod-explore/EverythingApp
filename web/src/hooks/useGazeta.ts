import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, bulkDismissGazetaItems, dismissGazetaItem, getGazetaItems, respondToGazetaItem } from '../api';
import { beep } from '../lib/beep';
import type { GazetaDelivery, GazetaItem, GazetaStatus } from '../types';

const POLL_MS = 30_000;
const MUTE_KEY = 'gazetaMuted';
const PENDING_LIMIT = 500;

/** Server order: urgent pending first, then newest (ties: id, for a stable order). */
export function compareGazeta(a: GazetaItem, b: GazetaItem): number {
  const ua = a.urgent && a.status === 'pending' ? 1 : 0;
  const ub = b.urgent && b.status === 'pending' ? 1 : 0;
  if (ua !== ub) return ub - ua;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

export interface GazetaStore {
  /** Every item this tab has seen (pending fetch, inbox pages, SSE), latest known state. */
  byId: Record<string, GazetaItem>;
  /** All open items, server order — drives the counter and the in-chat question cards. */
  pending: GazetaItem[];
  urgentCount: number;
  /** Ids that arrived over SSE this session, newest first — the inbox merges these into its pages. */
  arrivals: string[];
  /** How each answer given in this tab reached its agent (from the respond call). */
  delivered: Record<string, GazetaDelivery>;
  loading: boolean;
  muted: boolean;
  setMuted: (muted: boolean) => void;
  refresh: () => Promise<void>;
  upsert: (items: GazetaItem[]) => void;
  respond: (id: string, response: unknown) => Promise<GazetaDelivery>;
  dismiss: (id: string) => Promise<void>;
  bulkDismiss: (ids: string[]) => Promise<void>;
  /** Feed gazeta:* SSE events here (App's side-event handler). */
  handleEvent: (event: string, data: unknown) => void;
}

/**
 * The single Gazeta store, owned by App. The inbox modal and the in-chat
 * question cards both read from it, so an answer given in either place
 * (or in another tab — gazeta:responded is broadcast to every client)
 * updates both at once.
 */
export function useGazetaStore(): GazetaStore {
  const [byId, setById] = useState<Record<string, GazetaItem>>({});
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [arrivals, setArrivals] = useState<string[]>([]);
  const [delivered, setDelivered] = useState<Record<string, GazetaDelivery>>({});
  const [loading, setLoading] = useState(true);
  const [muted, setMutedState] = useState(() => {
    try {
      return localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const setMuted = useCallback((next: boolean) => {
    setMutedState(next);
    try {
      localStorage.setItem(MUTE_KEY, next ? '1' : '0');
    } catch {
      // session-only
    }
  }, []);

  const upsert = useCallback((items: GazetaItem[]) => {
    if (items.length === 0) return;
    setById(prev => {
      const next = { ...prev };
      for (const item of items) next[item.id] = item;
      return next;
    });
  }, []);

  const patch = useCallback((id: string, changes: Partial<GazetaItem>) => {
    setById(prev => (prev[id] ? { ...prev, [id]: { ...prev[id], ...changes } } : prev));
    if (changes.status && changes.status !== 'pending') setPendingIds(prev => prev.filter(x => x !== id));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { items } = await getGazetaItems({ status: 'pending', limit: PENDING_LIMIT });
      upsert(items);
      setPendingIds(items.map(i => i.id));
    } catch {
      // keep the last known state; the next poll retries
    }
  }, [upsert]);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
    // SSE (gazeta:*) is the fast path; this poll only covers a dropped stream.
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /** A 409 says "item is already <status>" — adopt that status instead of leaving a dead form on screen. */
  const adoptConflict = useCallback(
    (id: string, err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        const m = /already (\w+)/.exec(err.message);
        patch(id, { status: (m?.[1] as GazetaStatus | undefined) ?? 'responded' });
      }
    },
    [patch],
  );

  const respond = useCallback(
    async (id: string, response: unknown) => {
      try {
        const { delivered: how } = await respondToGazetaItem(id, response);
        patch(id, { status: 'responded', response, respondedAt: new Date().toISOString() });
        setDelivered(prev => ({ ...prev, [id]: how }));
        return how;
      } catch (err) {
        adoptConflict(id, err);
        throw err;
      }
    },
    [patch, adoptConflict],
  );

  const dismiss = useCallback(
    async (id: string) => {
      try {
        await dismissGazetaItem(id);
        patch(id, { status: 'dismissed' });
      } catch (err) {
        adoptConflict(id, err);
        throw err;
      }
    },
    [patch, adoptConflict],
  );

  const bulkDismiss = useCallback(
    async (ids: string[]) => {
      await bulkDismissGazetaItems(ids);
      for (const id of ids) patch(id, { status: 'dismissed' });
    },
    [patch],
  );

  const handleEvent = useCallback(
    (event: string, data: unknown) => {
      const d = (data ?? {}) as Record<string, unknown>;
      if (event === 'gazeta:new') {
        const item = d.item as GazetaItem | undefined;
        if (!item) {
          // batch_result is announced without the row — just refetch.
          void refresh();
          return;
        }
        upsert([item]);
        if (item.status === 'pending') setPendingIds(prev => (prev.includes(item.id) ? prev : [item.id, ...prev]));
        setArrivals(prev => (prev.includes(item.id) ? prev : [item.id, ...prev]));
        if (item.urgent && !mutedRef.current) beep();
      } else if (event === 'gazeta:responded') {
        const id = d.id as string;
        patch(id, { status: 'responded', response: d.response, respondedAt: new Date().toISOString() });
      } else if (event === 'gazeta:dismissed') {
        patch(d.id as string, { status: (d.status as GazetaStatus | undefined) ?? 'dismissed' });
      }
    },
    [refresh, upsert, patch],
  );

  const pending = useMemo(
    () =>
      pendingIds
        .map(id => byId[id])
        .filter((i): i is GazetaItem => Boolean(i) && i.status === 'pending')
        .sort(compareGazeta),
    [pendingIds, byId],
  );
  const urgentCount = useMemo(() => pending.filter(i => i.urgent).length, [pending]);

  return {
    byId,
    pending,
    urgentCount,
    arrivals,
    delivered,
    loading,
    muted,
    setMuted,
    refresh,
    upsert,
    respond,
    dismiss,
    bulkDismiss,
    handleEvent,
  };
}

export const GazetaContext = createContext<GazetaStore | null>(null);

export function useGazeta(): GazetaStore {
  const store = useContext(GazetaContext);
  if (!store) throw new Error('useGazeta() outside <GazetaContext.Provider>');
  return store;
}
