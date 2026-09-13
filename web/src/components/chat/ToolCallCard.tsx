import { useState } from 'react';
import { ChevronDown, ChevronRight, Maximize2, TriangleAlert, Wrench } from 'lucide-react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { FileViewer } from '../files/FileViewer';

const VIEWER_THRESHOLD = 500; // characters — past this, the inline preview clips and "View full" opens FileViewer

/**
 * Registered as `components.tools.Fallback` in MessagePrimitive.Parts (see
 * MessageBubble.tsx) — covers every tool, since this app doesn't register
 * per-tool-name renderers. `result` is a string when present (the backend's
 * truncated tool output text); everything else about the call comes
 * straight from the ToolCallMessagePart the runtime built in lib/messages.ts.
 *
 * Note: the backend's output-truncator.ts drops the middle of very long
 * output before it ever reaches the model or this UI — "View full" here
 * only re-shows what we already have (untruncated relative to the inline
 * preview), not the portion the backend itself removed. There's currently
 * no endpoint that returns the original, pre-truncation text.
 */
export function ToolCallCard({ toolName, args, result, isError }: ToolCallMessagePartProps) {
  const [open, setOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const running = result === undefined;
  const resultText = typeof result === 'string' ? result : result !== undefined ? JSON.stringify(result, null, 2) : undefined;
  const isLong = (resultText?.length ?? 0) > VIEWER_THRESHOLD;

  return (
    <div className="my-2 max-w-full rounded-container border border-border bg-bg-secondary text-sm not-prose">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-fg-secondary hover:text-fg"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Wrench size={14} className={running ? 'animate-pulse' : ''} />
        <span className="truncate font-mono text-xs">{toolName}</span>
        {isError && <TriangleAlert size={14} className="ml-auto shrink-0 text-danger" />}
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2 font-mono text-xs">
          {Object.keys(args ?? {}).length > 0 && (
            <div>
              <div className="mb-1 text-fg-tertiary">args</div>
              <pre className="overflow-x-auto whitespace-pre-wrap text-fg-secondary">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          <div>
            <div className="mb-1 flex items-center justify-between text-fg-tertiary">
              <span>{running ? 'running…' : isError ? 'error' : 'result'}</span>
              {isLong && (
                <button
                  onClick={() => setViewerOpen(true)}
                  className="flex items-center gap-1 text-fg-secondary hover:text-fg"
                >
                  <Maximize2 size={12} /> View full
                </button>
              )}
            </div>
            {resultText !== undefined && (
              <pre className={`overflow-x-auto whitespace-pre-wrap ${isError ? 'text-danger' : 'text-fg-secondary'}`}>
                {isLong ? `${resultText.slice(0, VIEWER_THRESHOLD)}…` : resultText}
              </pre>
            )}
          </div>
        </div>
      )}
      {viewerOpen && resultText !== undefined && (
        <FileViewer title={toolName} content={resultText} onClose={() => setViewerOpen(false)} />
      )}
    </div>
  );
}
