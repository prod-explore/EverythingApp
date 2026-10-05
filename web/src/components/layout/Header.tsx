import { useEffect, useRef, useState } from 'react';
import { Bot, FolderOpen, FolderTree, GitBranch, GitMerge as Github, Globe, LogOut, Menu, MoreHorizontal, Terminal } from 'lucide-react';
import { clearToken } from '../../api';
import type { DockTool } from '../../App';
import { ModelOptions } from '../shared/ModelOptions';
import type { ModelOption } from '../../types';

const TOOLS: { id: DockTool; label: string; icon: typeof Bot }[] = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'files', label: 'Files', icon: FolderTree },
  { id: 'scm', label: 'Source Control', icon: GitBranch },
  { id: 'github', label: 'GitHub', icon: Github },
];

function logout() {
  clearToken();
  window.location.reload();
}

export function Header({
  title,
  usage,
  model,
  models,
  sandboxEnabled,
  onModelChange,
  onSandboxToggle,
  onToggleSidebar,
  onOpenBrowser,
  onOpenArtifacts,
  browserPanelOpen,
  artifactsPanelOpen,
  dockTool,
  onToggleTool,
}: {
  title: string;
  usage: string;
  /** null until the full conversation loads, or when there's no conversation selected yet. */
  model: string | null;
  models: ModelOption[];
  /** undefined = loading/no conversation; otherwise reflects conversation.sandboxEnabled */
  sandboxEnabled: boolean | undefined;
  onModelChange: (model: string) => void;
  onSandboxToggle: (enabled: boolean) => void;
  onToggleSidebar: () => void;
  onOpenBrowser: () => void;
  onOpenArtifacts: () => void;
  browserPanelOpen: boolean;
  artifactsPanelOpen: boolean;
  dockTool: DockTool | null;
  onToggleTool: (tool: DockTool) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the overflow menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const pick = (fn: () => void) => () => {
    setMenuOpen(false);
    fn();
  };
  const itemClass = (active: boolean) =>
    `flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-bg-tertiary ${active ? 'text-fg' : 'text-fg-secondary'}`;

  return (
    <header className="flex items-center gap-2 border-b border-border px-3 py-3 md:gap-3 md:px-4">
      <button onClick={onToggleSidebar} className="shrink-0 text-fg-secondary hover:text-fg md:hidden" aria-label="Toggle sidebar">
        <Menu size={20} />
      </button>
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{title}</h1>

      {/* Desktop: everything inline. */}
      {sandboxEnabled !== undefined && (
        <button
          onClick={() => onSandboxToggle(!sandboxEnabled)}
          title={sandboxEnabled ? 'Sandbox enabled — click to disable' : 'Sandbox disabled — click to enable'}
          aria-label={sandboxEnabled ? 'Disable sandbox' : 'Enable sandbox'}
          className={`hidden shrink-0 items-center gap-1 rounded-button px-2 py-1 text-xs font-medium transition-colors md:flex ${
            sandboxEnabled
              ? 'border border-fg/30 text-fg hover:border-fg/60'
              : 'border border-border text-fg-tertiary hover:text-fg-secondary'
          }`}
        >
          <Terminal size={12} />
          {sandboxEnabled ? 'Sandbox on' : 'Sandbox off'}
        </button>
      )}

      {model !== null && (
        <select
          value={model}
          onChange={e => onModelChange(e.target.value)}
          title="Model for this conversation"
          aria-label="Model for this conversation"
          className="max-w-[8rem] shrink-0 truncate rounded-full border border-border bg-bg-secondary px-3 py-1 text-xs text-fg-secondary outline-none hover:border-border-hover md:max-w-[11rem]"
        >
          <ModelOptions models={models} current={model} />
        </select>
      )}

      <span className="hidden shrink-0 text-xs text-fg-tertiary md:inline">{usage}</span>

      <button onClick={logout} title="Log out" aria-label="Log out" className="hidden shrink-0 text-fg-tertiary hover:text-fg-secondary md:block">
        <LogOut size={16} />
      </button>

      {/* Mobile: one overflow menu instead of a row of buttons that overflows the screen. */}
      <div ref={menuRef} className="relative shrink-0 md:hidden">
        <button
          onClick={() => setMenuOpen(o => !o)}
          aria-label="More"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="rounded p-1 text-fg-secondary hover:text-fg"
        >
          <MoreHorizontal size={20} />
        </button>
        {menuOpen && (
          <div role="menu" className="absolute right-0 top-full z-50 mt-1 w-56 rounded-container border border-border bg-bg-secondary p-1 shadow-lg">
            <div className="px-3 py-1 text-xs text-fg-tertiary">{usage}</div>
            {sandboxEnabled !== undefined && (
              <button role="menuitem" className={itemClass(sandboxEnabled)} onClick={pick(() => onSandboxToggle(!sandboxEnabled))}>
                <Terminal size={15} /> {sandboxEnabled ? 'Sandbox on' : 'Sandbox off'}
              </button>
            )}
            <button role="menuitem" className={itemClass(browserPanelOpen)} onClick={pick(onOpenBrowser)}>
              <Globe size={15} /> {browserPanelOpen ? 'Hide browser' : 'Browser'}
            </button>
            <button role="menuitem" className={itemClass(artifactsPanelOpen)} onClick={pick(onOpenArtifacts)}>
              <FolderOpen size={15} /> {artifactsPanelOpen ? 'Hide artifacts' : 'Artifacts'}
            </button>
            {TOOLS.map(t => (
              <button key={t.id} role="menuitem" className={itemClass(dockTool === t.id)} onClick={pick(() => onToggleTool(t.id))}>
                <t.icon size={15} /> {dockTool === t.id ? `Hide ${t.label}` : t.label}
              </button>
            ))}
            <button role="menuitem" className={itemClass(false)} onClick={logout}>
              <LogOut size={15} /> Log out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
