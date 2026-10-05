import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Square } from 'lucide-react';
import { getRunTranscript, listConversationRuns, stopRun } from '../../api';
import type { BudgetWarning, RunRow } from '../../types';
import { DockPanel, PanelMessage } from '../shared/DockPanel';

const ACTIVE = new Set(['running', 'waiting_input', 'waiting_children']);

const STATUS_STYLE: Record<string, string> = {
  running: 'bg-accent/15 text-accent',
  waiting_input: 'bg-accent/15 text-accent',
  waiting_children: 'bg-accent/15 text-accent',
  done: 'bg-success/15 text-success',
  error: 'bg-danger/15 text-danger',
  aborted: 'bg-bg-tertiary text-fg-secondary',
  interrupted: 'bg-bg-tertiary text-fg-secondary',
};
const STATUS_LABEL: Record<string, string> = {
  running: 'running', waiting_input: 'waiting for you', waiting_children: 'waiting for agents',
  done: 'done', error: 'error', aborted: 'stopped', interrupted: 'interrupted',
};

/**
 * Agents tab (Plan v3 §7c): run trees of the current chat. Each chat turn is a root run ("assistant");
 * workers it spawned hang below it. Live via agent:* SSE (refreshKey) + polling while anything is active.
 */
export function AgentsPanel({ conversationId, refreshKey, budgetWarning, onClose }: {
  conversationId: string;
  refreshKey: number;
  budgetWarning: BudgetWarning | null;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRuns((await listConversationRuns(conversationId)).runs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [conversationId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const anyActive = runs?.some(r => ACTIVE.has(r.status)) ?? false;
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [anyActive, load]);

  const { roots, children } = useMemo(() => {
    const children = new Map<string, RunRow[]>();
    for (const r of runs ?? []) {
      if (!r.parentRunId) continue;
      const list = children.get(r.parentRunId) ?? [];
      list.push(r);
      children.set(r.parentRunId, list);
    }
    for (const list of children.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // Only turns that started agents (or the turn still running) — plain chat turns are noise here.
    const roots = (runs ?? []).filter(r => !r.parentRunId && (children.has(r.id) || ACTIVE.has(r.status)));
    return { roots, children };
  }, [runs]);

  return (
    <DockPanel title="Agents" icon={<Bot size={16} />} onClose={onClose}>
      {budgetWarning && (
        <div className="border-b border-danger/40 px-3 py-2 text-xs text-danger" role="status">
          This task's agents have spent ${budgetWarning.usage.costUsd.toFixed(2)} — close to the budget. New agents will be refused at the limit.
        </div>
      )}
      {error && <PanelMessage tone="error">{error}</PanelMessage>}
      {runs && roots.length === 0 && <PanelMessage>No agents in this chat yet. Ask the assistant to split work across agents (spawn_agent).</PanelMessage>}
      <ul className="space-y-2 p-2">
        {roots.map(root => (
          <li key={root.id}>
            <RunNode run={root} childrenOf={children} onChanged={load} />
          </li>
        ))}
      </ul>
    </DockPanel>
  );
}

function RunNode({ run, childrenOf, onChanged }: { run: RunRow; childrenOf: Map<string, RunRow[]>; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const kids = childrenOf.get(run.id) ?? [];
  const active = ACTIVE.has(run.status);
  const tokens = run.usage.inputTokens + run.usage.outputTokens;

  async function toggleTranscript() {
    if (transcript !== null) { setTranscript(null); return; }
    try {
      const { messages } = await getRunTranscript(run.id);
      setTranscript(renderTranscript(messages));
    } catch {
      setTranscript(active ? '(the transcript is saved when the agent finishes)' : '(no transcript)');
    }
  }

  return (
    <div className={`rounded-button border ${run.depth === 0 ? 'border-border' : 'border-border/70'} bg-bg`}>
      <div className="flex items-start gap-2 px-2 py-1.5">
        <button onClick={() => setOpen(o => !o)} className="mt-0.5 text-fg-tertiary hover:text-fg" aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-medium text-fg">{run.depth === 0 ? 'Turn' : run.label}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLE[run.status] ?? ''}`}>{STATUS_LABEL[run.status] ?? run.status}</span>
            <span className="text-fg-tertiary">{run.model}</span>
            <span className="text-fg-tertiary">{tokens.toLocaleString()} tok · ${run.usage.costUsd.toFixed(3)}</span>
          </div>
          <p className={`mt-0.5 text-xs text-fg-secondary ${open ? 'whitespace-pre-wrap' : 'truncate'}`}>{run.goal}</p>
        </div>
        {active && run.depth > 0 && (
          <button
            onClick={() => void stopRun(run.id).then(onChanged)}
            className="rounded p-1 text-fg-tertiary hover:text-danger"
            aria-label={`Stop ${run.label}`}
            title="Stop this agent and everything it started"
          >
            <Square size={13} />
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-1 border-t border-border px-2 py-1.5 text-xs">
          {run.result && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-bg-secondary p-2 font-sans text-fg">{run.result}</pre>}
          {run.error && <p className="text-danger">{run.error}</p>}
          {run.depth > 0 && (
            <button onClick={() => void toggleTranscript()} className="text-fg-tertiary underline hover:text-fg">
              {transcript === null ? 'Show transcript' : 'Hide transcript'}
            </button>
          )}
          {transcript !== null && <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-bg-secondary p-2 font-mono text-[11px] text-fg-secondary">{transcript}</pre>}
        </div>
      )}
      {kids.length > 0 && (
        <ul className="space-y-1.5 border-t border-border py-1.5 pl-4 pr-1.5">
          {kids.map(k => (
            <li key={k.id}>
              <RunNode run={k} childrenOf={childrenOf} onChanged={onChanged} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Compact text rendering of a worker's Anthropic-format transcript. */
function renderTranscript(messages: Array<{ role: string; content: unknown }>): string {
  const out: string[] = [];
  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as Array<Record<string, unknown>>);
    for (const b of blocks) {
      if (b['type'] === 'text' && b['text']) out.push(`${m.role === 'user' ? '›' : '‹'} ${String(b['text']).slice(0, 1500)}`);
      else if (b['type'] === 'tool_use') out.push(`⚙ ${String(b['name'])} ${JSON.stringify(b['input']).slice(0, 300)}`);
      else if (b['type'] === 'tool_result') {
        const c = b['content'];
        const text = typeof c === 'string' ? c : JSON.stringify(c);
        out.push(`  ↳ ${b['is_error'] ? '[error] ' : ''}${text.slice(0, 400)}`);
      }
    }
  }
  return out.join('\n');
}
