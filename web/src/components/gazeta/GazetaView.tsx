import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Newspaper, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { getGazetaItems } from '../../api';
import { compareGazeta, useGazeta } from '../../hooks/useGazeta';
import type { GazetaItem, ProjectListItem } from '../../types';
import { Button } from '../shared/Button';
import { EmptyState } from '../shared/EmptyState';
import { Modal } from '../shared/Modal';
import { GazetaCard, TYPE_LABEL } from './GazetaCard';

const PAGE = 30;
const TYPES = ['agent_question', 'report', 'batch_result', 'daily_summary'] as const;

interface Filters {
  projectId: string;
  agent: string;
  type: string;
  status: 'open' | 'all';
}

const SELECT_CLASS =
  'rounded-button border border-border bg-bg px-2 py-1.5 text-xs text-fg-secondary outline-none hover:border-border-hover focus:border-border-hover';

/** Client-side mirror of the server filter, for items that arrive over SSE after the pages loaded. */
function matches(item: GazetaItem, f: Filters): boolean {
  return (!f.projectId || item.projectId === f.projectId) && (!f.agent || item.agent === f.agent) && (!f.type || item.type === f.type);
}

/**
 * Cursor for the next page. The server pins urgent open items on top
 * regardless of age, so the oldest createdAt on a page can belong to a
 * pinned item and would skip everything between — use the oldest
 * non-pinned item instead (pinned ones that reappear are de-duplicated).
 */
function nextCursor(items: GazetaItem[]): string | undefined {
  const regular = items.filter(i => !(i.urgent && i.status === 'pending'));
  const pool = regular.length > 0 ? regular : items;
  return pool.reduce<string | undefined>((min, i) => (min === undefined || i.createdAt < min ? i.createdAt : min), undefined);
}

export function GazetaView({
  onClose,
  onOpenConversation,
  projects,
}: {
  onClose: () => void;
  onOpenConversation?: (conversationId: string) => void;
  projects: ProjectListItem[];
}) {
  const store = useGazeta();
  const { byId, arrivals, upsert, bulkDismiss, muted, setMuted } = store;
  const [filters, setFilters] = useState<Filters>({ projectId: '', agent: '', type: '', status: 'open' });
  const [pageIds, setPageIds] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loadingPage, setLoadingPage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Arrivals already in the store when the view opened are covered by the first page fetch.
  const [arrivalsAtOpen] = useState(() => new Set(arrivals));
  const requestSeq = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadPage = useCallback(
    async (reset: boolean) => {
      const seq = ++requestSeq.current;
      setLoadingPage(true);
      setError(null);
      try {
        const { items } = await getGazetaItems({
          status: filters.status === 'open' ? 'pending' : undefined,
          projectId: filters.projectId || undefined,
          agent: filters.agent || undefined,
          type: filters.type || undefined,
          before: reset ? undefined : cursor,
          limit: PAGE,
        });
        if (seq !== requestSeq.current) return; // a newer filter change won
        upsert(items);
        setPageIds(prev => {
          const base = reset ? [] : prev;
          const seen = new Set(base);
          return [...base, ...items.map(i => i.id).filter(id => !seen.has(id))];
        });
        setCursor(prev => nextCursor(items) ?? (reset ? undefined : prev));
        setHasMore(items.length === PAGE);
      } catch (err) {
        if (seq === requestSeq.current) setError((err as Error).message);
      } finally {
        if (seq === requestSeq.current) setLoadingPage(false);
      }
    },
    [filters, cursor, upsert],
  );

  // Fresh first page whenever the filters change.
  const loadPageRef = useRef(loadPage);
  loadPageRef.current = loadPage;
  useEffect(() => {
    setSelected(new Set());
    setPageIds([]);
    setCursor(undefined);
    setHasMore(true);
    void loadPageRef.current(true);
  }, [filters]);

  // Infinite scroll: the sentinel sits under the list inside the modal's scroll body.
  useEffect(() => {
    const el = sentinelRef.current;
    // Only after a first page exists — the first page itself comes from the filters effect.
    if (!el || !hasMore || loadingPage || pageIds.length === 0) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        observer.disconnect();
        void loadPageRef.current(false);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadingPage, pageIds.length]);

  const visible = useMemo(() => {
    const ids = new Set(pageIds);
    for (const id of arrivals) {
      if (arrivalsAtOpen.has(id) || ids.has(id)) continue;
      const item = byId[id];
      if (item && matches(item, filters)) ids.add(id);
    }
    return [...ids]
      .map(id => byId[id])
      .filter((i): i is GazetaItem => Boolean(i))
      .sort(compareGazeta);
  }, [pageIds, arrivals, arrivalsAtOpen, byId, filters]);

  const openVisible = visible.filter(i => i.status === 'pending');
  const selectedOpen = openVisible.filter(i => selected.has(i.id)).map(i => i.id);
  const allSelected = openVisible.length > 0 && selectedOpen.length === openVisible.length;

  const agents = useMemo(() => {
    const set = new Set<string>(['assistant']);
    for (const item of Object.values(byId)) if (item.agent) set.add(item.agent);
    if (filters.agent) set.add(filters.agent);
    return [...set].sort();
  }, [byId, filters.agent]);

  const projectNames = useMemo(() => new Map(projects.map(p => [p.id, p.name])), [projects]);

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkDismiss() {
    if (selectedOpen.length === 0) return;
    setBulkBusy(true);
    try {
      await bulkDismiss(selectedOpen);
      setSelected(new Set());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters(prev => ({ ...prev, [key]: value }));

  return (
    <Modal
      title="Gazeta"
      onClose={onClose}
      wide
      headerExtra={
        <>
          <button
            onClick={() => setMuted(!muted)}
            className="rounded-full p-1 text-fg-secondary hover:bg-bg-tertiary hover:text-fg"
            aria-label={muted ? 'Unmute urgent-item sound' : 'Mute urgent-item sound'}
            aria-pressed={muted}
            title={muted ? 'Urgent sound muted' : 'Urgent sound on'}
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <button
            onClick={() => {
              void store.refresh();
              void loadPage(true);
            }}
            disabled={loadingPage}
            className="rounded-full p-1 text-fg-secondary hover:bg-bg-tertiary hover:text-fg disabled:opacity-40"
            aria-label="Refresh"
          >
            <RefreshCw size={16} className={loadingPage ? 'animate-spin' : ''} />
          </button>
        </>
      }
      tabs={
        <div className="mb-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
            <div className="flex overflow-hidden rounded-button border border-border text-xs" role="radiogroup" aria-label="Status">
              {(['open', 'all'] as const).map(s => (
                <button
                  key={s}
                  role="radio"
                  aria-checked={filters.status === s}
                  onClick={() => setFilter('status', s)}
                  className={`px-3 py-1.5 ${filters.status === s ? 'bg-bg-tertiary text-fg' : 'text-fg-tertiary hover:text-fg-secondary'}`}
                >
                  {s === 'open' ? 'Open' : 'All'}
                </button>
              ))}
            </div>
            <select aria-label="Project" value={filters.projectId} onChange={e => setFilter('projectId', e.target.value)} className={SELECT_CLASS}>
              <option value="">All projects</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select aria-label="Agent" value={filters.agent} onChange={e => setFilter('agent', e.target.value)} className={SELECT_CLASS}>
              <option value="">All agents</option>
              {agents.map(a => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <select aria-label="Type" value={filters.type} onChange={e => setFilter('type', e.target.value)} className={SELECT_CLASS}>
              <option value="">All types</option>
              {TYPES.map(t => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          {openVisible.length > 0 && (
            <div className="flex items-center gap-3 text-xs text-fg-secondary">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(openVisible.map(i => i.id)))}
                  className="h-4 w-4 accent-[var(--color-fg)]"
                />
                Select all open
              </label>
              <Button variant="ghost" className="!px-3 !py-1 text-xs" disabled={selectedOpen.length === 0 || bulkBusy} onClick={() => void handleBulkDismiss()}>
                Dismiss selected{selectedOpen.length > 0 ? ` (${selectedOpen.length})` : ''}
              </Button>
            </div>
          )}
        </div>
      }
    >
      {error && (
        <p className="mb-3 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      {visible.length === 0 && !loadingPage ? (
        <EmptyState icon={Newspaper} message={filters.status === 'open' ? 'Nothing waiting for you.' : 'No items match these filters.'} />
      ) : (
        <div className="space-y-3">
          {visible.map(item => (
            <GazetaCard
              key={item.id}
              item={item}
              projectName={item.projectId ? projectNames.get(item.projectId) : undefined}
              selected={selected.has(item.id)}
              onToggleSelect={() => toggle(item.id)}
              onOpenConversation={
                onOpenConversation
                  ? id => {
                      onOpenConversation(id);
                      onClose();
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}
      <div ref={sentinelRef} aria-hidden="true" className="h-4" />
      {loadingPage && <p className="py-2 text-center text-xs text-fg-tertiary">Loading…</p>}
      {!hasMore && visible.length > PAGE && <p className="py-2 text-center text-xs text-fg-tertiary">That's everything.</p>}
    </Modal>
  );
}
