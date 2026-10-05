import { useState, type ReactNode } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { ChevronDown, ChevronRight, ListChecks } from 'lucide-react';
import { LatestStepContext } from './stepContext';

type Props = { indices: readonly number[]; running: boolean; children: ReactNode };

/** Wraps adjacent tool calls in one assistant message into a single collapsible "N steps" block. */
export function StepGroup({ indices, running, children }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const latestId = useAuiState(s => {
    for (let i = indices.length - 1; i >= 0; i--) {
      const part = s.message.content[indices[i]!];
      if (part?.type === 'tool-call') return part.toolCallId;
    }
    return null;
  });

  return (
    <div className="my-2 not-prose">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="flex items-center gap-2 text-xs text-fg-tertiary hover:text-fg-secondary"
        aria-expanded={!collapsed}
      >
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <ListChecks size={13} className={running ? 'animate-pulse' : ''} />
        <span>
          {indices.length} {indices.length === 1 ? 'step' : 'steps'}
          {running ? ' · running…' : ''}
        </span>
      </button>
      {!collapsed && (
        <LatestStepContext.Provider value={running ? latestId : null}>
          <div className="mt-1 border-l border-border pl-3">{children}</div>
        </LatestStepContext.Provider>
      )}
    </div>
  );
}
