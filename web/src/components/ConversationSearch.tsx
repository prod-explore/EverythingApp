import { Fragment, useEffect, useMemo, useState } from 'react';
import { searchMessages, type SearchHit } from '../api';
import type { ConversationSummary } from '../types';

export function ConversationSearch({
  conversations,
  onSelect,
  onClose,
}: {
  conversations: ConversationSummary[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(
    () => conversations.filter(c => c.title.toLowerCase().includes(query.toLowerCase())),
    [conversations, query],
  );

  // Full-text hits across all message bodies (server-side FTS5); titles above are matched locally and instantly.
  const [hits, setHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); return; }
    let cancelled = false;
    const t = setTimeout(() => { searchMessages(q).then(h => { if (!cancelled) setHits(h); }).catch(() => { if (!cancelled) setHits([]); }); }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  return (
    <div role="dialog" aria-modal="true" aria-label="Search conversations" className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 pt-24" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-container border border-border bg-bg-secondary"
        onClick={e => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && filtered[0]) {
              onSelect(filtered[0].id);
              onClose();
            }
          }}
          placeholder="Search conversations…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-fg outline-none placeholder:text-fg-tertiary"
        />
        <div className="max-h-72 overflow-y-auto">
          {filtered.map(c => (
            <button
              key={c.id}
              onClick={() => {
                onSelect(c.id);
                onClose();
              }}
              className="block w-full truncate px-4 py-2.5 text-left text-sm text-fg-secondary hover:bg-bg-tertiary hover:text-fg"
            >
              {c.title}
            </button>
          ))}
          {hits.length > 0 && <p className="px-4 pb-1 pt-2 text-[11px] uppercase tracking-wide text-fg-tertiary">In messages</p>}
          {hits.map(h => (
            <button
              key={h.messageId}
              onClick={() => { onSelect(h.conversationId); onClose(); }}
              className="block w-full px-4 py-2 text-left hover:bg-bg-tertiary"
            >
              <span className="block truncate text-xs text-fg-tertiary">{h.title}</span>
              <span className="block text-sm text-fg-secondary"><Snippet text={h.snippet} /></span>
            </button>
          ))}
          {filtered.length === 0 && hits.length === 0 && <p className="px-4 py-3 text-sm text-fg-tertiary">No matches.</p>}
        </div>
      </div>
    </div>
  );
}

/** Renders ⟦match⟧ markers from the server as <mark>, without ever treating the text as HTML. */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split(/(⟦[^⟧]*⟧)/).map((part, i) =>
        part.startsWith('⟦') ? <mark key={i} className="rounded bg-accent/30 px-0.5 text-fg">{part.slice(1, -1)}</mark> : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  );
}
