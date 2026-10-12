import { useEffect, useMemo, useState } from 'react';
import { useAui, useAuiState } from '@assistant-ui/react';

export interface SlashCommand { name: string; hint: string }

/** Commands the composer understands. Chat-level ones are handled in App.tsx via the `app:command` event. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'new', hint: 'Start a new conversation' },
  { name: 'export', hint: 'Download this chat as Markdown' },
  { name: 'sandbox', hint: 'Toggle the sandbox for this chat' },
  { name: 'agents', hint: 'Open the Agents panel' },
  { name: 'files', hint: 'Open the Files panel' },
  { name: 'search', hint: 'Search all conversations' },
];

/** Lists commands while the composer text is a bare "/word"; Enter/Tab runs the highlighted one. */
export function SlashMenu({ onCommand }: { onCommand: (name: string) => void }) {
  const aui = useAui();
  const text = useAuiState(s => s.composer.text);
  const [active, setActive] = useState(0);
  const query = /^\/(\w*)$/.exec(text)?.[1];
  const matches = useMemo(() => (query === undefined ? [] : SLASH_COMMANDS.filter(c => c.name.startsWith(query.toLowerCase()))), [query]);
  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    if (!matches.length) return;
    const run = (name: string) => { aui.thread.composer().setText(''); onCommand(name); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % matches.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + matches.length) % matches.length); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); run(matches[active]!.name); }
      else if (e.key === 'Escape') { aui.thread.composer().setText(''); }
    };
    // Capture phase: must run before the textarea's own Enter-to-send handling.
    const input = document.getElementById('composer-input');
    input?.addEventListener('keydown', onKey, true);
    return () => input?.removeEventListener('keydown', onKey, true);
  }, [matches, active, aui, onCommand]);

  if (!matches.length) return null;
  return (
    <div className="mx-auto w-full max-w-3xl px-3">
      <div role="listbox" aria-label="Commands" className="overflow-hidden rounded-container border border-border bg-bg-secondary shadow-lg">
        {matches.map((c, i) => (
          <div
            key={c.name}
            role="option"
            aria-selected={i === active}
            tabIndex={-1}
            onMouseDown={e => { e.preventDefault(); aui.thread.composer().setText(''); onCommand(c.name); }}
            className={`flex w-full cursor-pointer items-baseline gap-3 px-3 py-2 text-left text-sm ${i === active ? 'bg-bg-tertiary text-fg' : 'text-fg-secondary'}`}
          >
            <span className="font-mono">/{c.name}</span>
            <span className="truncate text-xs text-fg-tertiary">{c.hint}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
