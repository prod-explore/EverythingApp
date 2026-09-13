import { useMemo, useState } from 'react';
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

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 pt-24" onClick={onClose}>
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
          {filtered.length === 0 && <p className="px-4 py-3 text-sm text-fg-tertiary">No matches.</p>}
        </div>
      </div>
    </div>
  );
}
