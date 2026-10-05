import type { PropsWithChildren, ReactNode } from 'react';
import { X } from 'lucide-react';

/** Common frame for right-dock panels (Agents, Files, Source Control, GitHub): header + scrollable body. */
export function DockPanel({ title, icon, onClose, actions, children }: PropsWithChildren<{ title: string; icon?: ReactNode; onClose: () => void; actions?: ReactNode }>) {
  return (
    <section className="flex min-h-0 flex-1 flex-col border-b border-border" aria-label={title}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {icon && <span className="text-fg-secondary">{icon}</span>}
        <h2 className="flex-1 truncate text-sm font-medium text-fg">{title}</h2>
        {actions}
        <button onClick={onClose} className="rounded p-1 text-fg-tertiary hover:bg-bg-secondary hover:text-fg" aria-label={`Close ${title}`}>
          <X size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

export function PanelMessage({ children, tone = 'muted' }: PropsWithChildren<{ tone?: 'muted' | 'error' }>) {
  return <p className={`px-3 py-4 text-center text-xs ${tone === 'error' ? 'text-danger' : 'text-fg-tertiary'}`}>{children}</p>;
}
