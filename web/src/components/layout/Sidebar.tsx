import { useState } from 'react';
import { MessageSquarePlus, Newspaper, Pencil, Settings, Trash2 } from 'lucide-react';
import type { ConversationSummary } from '../../types';
import { Button } from '../shared/Button';
import { GazetaCounter } from '../gazeta/GazetaCounter';

export function Sidebar({
  conversations,
  selectedId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onOpenGazeta,
  onOpenSettings,
  gazetaCount,
}: {
  conversations: ConversationSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onOpenGazeta: () => void;
  onOpenSettings: () => void;
  gazetaCount: number;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  function startEdit(c: ConversationSummary) {
    setEditingId(c.id);
    setDraftTitle(c.title);
  }

  function commitEdit() {
    if (editingId && draftTitle.trim()) onRename(editingId, draftTitle.trim());
    setEditingId(null);
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-bg">
      <div className="p-3">
        <Button variant="ghost" className="flex w-full items-center justify-center gap-2" onClick={onCreate}>
          <MessageSquarePlus size={16} /> New conversation
        </Button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2">
        {conversations.map(c => (
          <div
            key={c.id}
            className={`group mb-1 flex items-center gap-1 rounded-button px-2 py-2 text-sm ${
              c.id === selectedId ? 'bg-bg-tertiary text-fg' : 'text-fg-secondary hover:bg-bg-secondary'
            }`}
          >
            {editingId === c.id ? (
              <input
                autoFocus
                value={draftTitle}
                onChange={e => setDraftTitle(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={e => e.key === 'Enter' && commitEdit()}
                className="min-w-0 flex-1 rounded bg-bg-secondary px-1 py-0.5 text-fg outline-none"
              />
            ) : (
              <button onClick={() => onSelect(c.id)} className="min-w-0 flex-1 truncate text-left">
                {c.title}
              </button>
            )}
            <button
              onClick={() => startEdit(c)}
              className="shrink-0 rounded p-1 text-fg-tertiary opacity-0 hover:text-fg group-hover:opacity-100"
              aria-label="Rename"
            >
              <Pencil size={13} />
            </button>
            <button
              onClick={() => onDelete(c.id)}
              className="shrink-0 rounded p-1 text-fg-tertiary opacity-0 hover:text-danger group-hover:opacity-100"
              aria-label="Delete"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </nav>

      <div className="space-y-1 border-t border-border p-2">
        <button
          onClick={onOpenGazeta}
          className="flex w-full items-center gap-2 rounded-button px-2 py-2 text-sm text-fg-secondary hover:bg-bg-secondary hover:text-fg"
        >
          <Newspaper size={16} />
          Gazeta
          {gazetaCount > 0 && <GazetaCounter count={gazetaCount} />}
        </button>
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-button px-2 py-2 text-sm text-fg-secondary hover:bg-bg-secondary hover:text-fg"
        >
          <Settings size={16} />
          Settings
        </button>
      </div>
    </aside>
  );
}
