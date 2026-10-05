import { FolderOpen, MessageSquarePlus, Newspaper, PanelLeftOpen, Settings } from 'lucide-react';

/** Desktop-only icon strip shown instead of the full sidebar while it is collapsed (Ctrl+B expands). */
export function SidebarRail({
  gazetaCount,
  gazetaUrgent = 0,
  onExpand,
  onCreate,
  onOpenProjects,
  onOpenGazeta,
  onOpenSettings,
}: {
  gazetaCount: number;
  gazetaUrgent?: number;
  onExpand: () => void;
  onCreate: () => void;
  onOpenProjects: () => void;
  onOpenGazeta: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <nav className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-bg py-2" aria-label="Collapsed sidebar">
      <RailButton label="Expand sidebar (Ctrl+B)" onClick={onExpand}>
        <PanelLeftOpen size={18} />
      </RailButton>
      <RailButton label="New chat" onClick={onCreate}>
        <MessageSquarePlus size={18} />
      </RailButton>
      <RailButton label="Projects" onClick={onOpenProjects}>
        <FolderOpen size={18} />
      </RailButton>
      <div className="flex-1" />
      <RailButton label={gazetaUrgent > 0 ? `Gazeta (${gazetaUrgent} urgent)` : 'Gazeta'} onClick={onOpenGazeta}>
        <span className="relative">
          <Newspaper size={18} />
          {gazetaCount > 0 && (
            <span
              className={`absolute -right-2 -top-2 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 text-bg ${gazetaUrgent > 0 ? 'bg-danger' : 'bg-fg'}`}
            >
              {gazetaCount > 99 ? '99+' : gazetaCount}
            </span>
          )}
        </span>
      </RailButton>
      <RailButton label="Settings" onClick={onOpenSettings}>
        <Settings size={18} />
      </RailButton>
    </nav>
  );
}

function RailButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-9 w-9 items-center justify-center rounded-button text-fg-tertiary transition-colors hover:bg-bg-secondary hover:text-fg"
    >
      {children}
    </button>
  );
}
