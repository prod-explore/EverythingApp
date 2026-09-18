import { LogOut, Menu, Terminal } from 'lucide-react';
import { clearToken } from '../../api';
import { MODELS } from '../../lib/models';

export function Header({
  title,
  usage,
  model,
  sandboxEnabled,
  onModelChange,
  onSandboxToggle,
  onToggleSidebar,
}: {
  title: string;
  usage: string;
  /** null until the full conversation loads, or when there's no conversation selected yet. */
  model: string | null;
  /** undefined = loading/no conversation; otherwise reflects conversation.sandboxEnabled */
  sandboxEnabled: boolean | undefined;
  onModelChange: (model: string) => void;
  onSandboxToggle: (enabled: boolean) => void;
  onToggleSidebar: () => void;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-3">
      <button onClick={onToggleSidebar} className="text-fg-secondary hover:text-fg md:hidden" aria-label="Toggle sidebar">
        <Menu size={20} />
      </button>
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{title}</h1>

      {/* Sandbox toggle */}
      {sandboxEnabled !== undefined && (
        <button
          onClick={() => onSandboxToggle(!sandboxEnabled)}
          title={sandboxEnabled ? 'Sandbox enabled — click to disable' : 'Sandbox disabled — click to enable'}
          aria-label={sandboxEnabled ? 'Disable sandbox' : 'Enable sandbox'}
          className={`flex shrink-0 items-center gap-1 rounded-button px-2 py-1 text-xs font-medium transition-colors ${
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
          className="shrink-0 rounded-button border border-border bg-bg-secondary px-2 py-1 text-xs text-fg-secondary outline-none hover:border-border-hover"
        >
          {/* The conversation's current model might not be one of the
              picker's usual options (an older/retired model still on an
              existing conversation) — show it anyway rather than silently
              swapping the selection to the first option in the list. */}
          {!MODELS.includes(model) && <option value={model}>{model}</option>}
          {MODELS.map(m => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      )}

      <span className="shrink-0 text-xs text-fg-tertiary">{usage}</span>

      <button
        onClick={() => {
          clearToken();
          window.location.reload();
        }}
        title="Log out"
        aria-label="Log out"
        className="shrink-0 text-fg-tertiary hover:text-fg-secondary"
      >
        <LogOut size={16} />
      </button>
    </header>
  );
}
