import { Menu } from 'lucide-react';

export function Header({
  title,
  usage,
  onToggleSidebar,
}: {
  title: string;
  usage: string;
  onToggleSidebar: () => void;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-3">
      <button onClick={onToggleSidebar} className="text-fg-secondary hover:text-fg md:hidden" aria-label="Toggle sidebar">
        <Menu size={20} />
      </button>
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{title}</h1>
      <span className="shrink-0 text-xs text-fg-tertiary">{usage}</span>
    </header>
  );
}
