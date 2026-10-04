import { useState } from 'react';
import { FolderOpen, MessageSquarePlus, Newspaper, Pencil, Plus, Settings, Trash2 } from 'lucide-react';
import type { ConversationSummary, ProjectListItem } from '../../types';
import { Button } from '../shared/Button';
import { GazetaCounter } from '../gazeta/GazetaCounter';

type SidebarView = 'chats' | 'projects';

export function Sidebar({
  conversations,
  projects,
  selectedId,
  selectedProjectId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onOpenGazeta,
  onOpenSettings,
  onCreateProject,
  onSelectProject,
  gazetaCount,
}: {
  conversations: ConversationSummary[];
  projects: ProjectListItem[];
  selectedId: string | null;
  selectedProjectId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onOpenGazeta: () => void;
  onOpenSettings: () => void;
  onCreateProject: () => void;
  onSelectProject: (id: string) => void;
  gazetaCount: number;
}) {
  const [view, setView] = useState<SidebarView>('chats');
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

  // Conversations without a project (quick chats)
  const quickChats = conversations.filter(c => !('projectId' in c) || (c as ConversationSummary & { projectId?: string | null }).projectId == null);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-bg">
      {/* View switcher */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setView('chats')}
          className={`flex-1 py-2 text-xs font-medium transition-colors ${
            view === 'chats'
              ? 'border-b-2 border-fg text-fg'
              : 'text-fg-tertiary hover:text-fg-secondary'
          }`}
        >
          Chats
        </button>
        <button
          onClick={() => setView('projects')}
          className={`flex-1 py-2 text-xs font-medium transition-colors ${
            view === 'projects'
              ? 'border-b-2 border-fg text-fg'
              : 'text-fg-tertiary hover:text-fg-secondary'
          }`}
        >
          Projects
        </button>
      </div>

      {view === 'chats' ? (
        <>
          <div className="p-3">
            <Button variant="ghost" className="flex w-full items-center justify-center gap-2" onClick={onCreate}>
              <MessageSquarePlus size={16} /> New conversation
            </Button>
          </div>

          <nav className="flex-1 overflow-y-auto px-2">
            {quickChats.map(c => (
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
            {quickChats.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-fg-tertiary">No quick chats yet</p>
            )}
          </nav>
        </>
      ) : (
        <>
          <div className="p-3">
            <Button variant="ghost" className="flex w-full items-center justify-center gap-2" onClick={onCreateProject}>
              <Plus size={16} /> New project
            </Button>
          </div>

          <nav className="flex-1 overflow-y-auto px-2">
            {projects.map(p => (
              <div key={p.id}>
                <button
                  onClick={() => onSelectProject(p.id)}
                  className={`group mb-1 flex w-full items-center gap-2 rounded-button px-2 py-2 text-sm ${
                    p.id === selectedProjectId ? 'bg-bg-tertiary text-fg' : 'text-fg-secondary hover:bg-bg-secondary'
                  }`}
                >
                  <FolderOpen size={14} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left">{p.name}</span>
                  <span className="shrink-0 text-xs text-fg-tertiary">{p.conversationCount}</span>
                </button>
                {/* Chats in selected project */}
                {p.id === selectedProjectId && (
                  <div className="mb-2 ml-4 border-l border-border pl-2">
                    {conversations
                      .filter(c => (c as ConversationSummary & { projectId?: string | null }).projectId === p.id)
                      .map(c => (
                        <button
                          key={c.id}
                          onClick={() => onSelect(c.id)}
                          className={`mb-0.5 w-full truncate rounded px-2 py-1.5 text-left text-xs ${
                            c.id === selectedId ? 'bg-bg-tertiary text-fg' : 'text-fg-secondary hover:bg-bg-secondary'
                          }`}
                        >
                          {c.title}
                        </button>
                      ))}
                    <button
                      onClick={onCreate}
                      className="mt-1 flex w-full items-center gap-1 rounded px-2 py-1 text-xs text-fg-tertiary hover:text-fg-secondary"
                    >
                      <Plus size={11} /> New chat in project
                    </button>
                  </div>
                )}
              </div>
            ))}
            {projects.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-fg-tertiary">No projects yet</p>
            )}
          </nav>
        </>
      )}

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
