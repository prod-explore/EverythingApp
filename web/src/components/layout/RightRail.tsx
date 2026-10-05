import { FolderOpen, Globe } from 'lucide-react';

/** Desktop-only icon strip on the far right: toggles the docked browser / artifacts panels. */
export function RightRail({
  browserOpen,
  artifactsOpen,
  onToggleBrowser,
  onToggleArtifacts,
}: {
  browserOpen: boolean;
  artifactsOpen: boolean;
  onToggleBrowser: () => void;
  onToggleArtifacts: () => void;
}) {
  const button = (active: boolean, label: string, onClick: () => void, icon: React.ReactNode) => (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-9 w-9 items-center justify-center rounded-button transition-colors ${
        active ? 'bg-bg-secondary text-fg' : 'text-fg-tertiary hover:bg-bg-secondary hover:text-fg'
      }`}
    >
      {icon}
    </button>
  );
  return (
    <nav className="hidden w-12 shrink-0 flex-col items-center gap-1 border-l border-border bg-bg py-2 md:flex" aria-label="Panels">
      {button(browserOpen, browserOpen ? 'Hide browser' : 'Show browser', onToggleBrowser, <Globe size={18} />)}
      {button(artifactsOpen, artifactsOpen ? 'Hide artifacts' : 'Show artifacts', onToggleArtifacts, <FolderOpen size={18} />)}
    </nav>
  );
}
