import { useState } from 'react';
import { MessagePrimitive, useAuiState } from '@assistant-ui/react';
import { ChevronDown, ChevronRight, Minimize2 } from 'lucide-react';

/** Marks the point where older messages were replaced by a summary for the model; the summary itself can be opened. */
export function CompactionNotice() {
  const [open, setOpen] = useState(false);
  const text = useAuiState(s =>
    s.message.content.filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text').map(c => c.text).join(''),
  );
  return (
    <MessagePrimitive.Root className="my-1 text-xs text-fg-tertiary">
      <div className="flex items-center gap-2">
        <span className="h-px flex-1 bg-border" />
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 hover:text-fg-secondary" aria-expanded={open}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Minimize2 size={12} /> Earlier messages summarised to save context
        </button>
        <span className="h-px flex-1 bg-border" />
      </div>
      {open && <div className="mx-auto mt-2 max-w-2xl whitespace-pre-wrap rounded-button border border-border bg-bg-secondary p-3 text-fg-secondary">{text}</div>}
    </MessagePrimitive.Root>
  );
}
