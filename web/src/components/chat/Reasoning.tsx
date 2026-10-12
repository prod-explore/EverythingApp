import { useState } from 'react';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';

/** The model's reasoning, collapsed once the answer is done and open while it is still thinking. */
export function Reasoning({ text, running }: { text: string; running: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? running;
  return (
    <div className="my-2 not-prose">
      <button
        onClick={() => setOpen(!expanded)}
        className="flex items-center gap-2 text-xs text-fg-tertiary hover:text-fg-secondary"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Brain size={13} className={running ? 'animate-pulse' : ''} />
        <span>{running ? 'Thinking…' : 'Thought process'}</span>
      </button>
      {expanded && (
        <div className="mt-1 max-h-80 overflow-y-auto whitespace-pre-wrap border-l border-border pl-3 text-xs text-fg-tertiary">{text}</div>
      )}
    </div>
  );
}
