import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Send, Square } from 'lucide-react';
import { getRunTranscript, listConversationRuns, messageRun, stopRun } from '../../api';
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
 * Agents tab (Plan v3 §7c): the worker agents of the current chat, split into Active and Completed. Finished agents
 * stay in the list — they keep their transcript and wake up when you send them a follow-up. Live via agent:* SSE
 * (refreshKey) + polling while anything is active.
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

  const { active, completed, labelOf } = useMemo(() => {
    const workers = (runs ?? []).filter(r => r.depth > 0);
    const labelOf = new Map((runs ?? []).map(r => [r.id, r.depth === 0 ? 'the assistant' : r.label]));
    const byNewest = (a: RunRow, b: RunRow) => b.createdAt.localeCompare(a.createdAt);
    return {
      active: workers.filter(r => ACTIVE.has(r.status)).sort(byNewest),
      completed: workers.filter(r => !ACTIVE.has(r.status)).sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt)),
      labelOf,
    };
  }, [runs]);

  return (
    <DockPanel title="Agents" icon={<Bot size={16} />} onClose={onClose}>
      {budgetWarning && (
        <div className="border-b border-danger/40 px-3 py-2 text-xs text-danger" role="status">
          This task's agents have used {(budgetWarning.usage.inputTokens + budgetWarning.usage.outputTokens).toLocaleString()} tokens — close to the budget. New agents will be refused at the limit.
        </div>
      )}
      {error && <PanelMessage tone="error">{error}</PanelMessage>}
      {runs && active.length + completed.length === 0 && <PanelMessage>No agents in this chat yet. Ask the assistant to split work across agents (spawn_agent).</PanelMessage>}
      {active.length > 0 && (
        <section aria-label="Active agents">
          <h3 className="px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-fg-tertiary">Active · {active.length}</h3>
          <ul className="space-y-2 p-2">
            {active.map(r => <li key={r.id}><AgentCard run={r} startedBy={r.parentRunId ? labelOf.get(r.parentRunId) : undefined} onChanged={load} /></li>)}
          </ul>
        </section>
      )}
      {completed.length > 0 && (
        <section aria-label="Completed agents">
          <h3 className="px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-fg-tertiary">Completed · {completed.length}</h3>
          <ul className="space-y-2 p-2">
            {completed.map(r => <li key={r.id}><AgentCard run={r} startedBy={r.parentRunId ? labelOf.get(r.parentRunId) : undefined} onChanged={load} /></li>)}
          </ul>
        </section>
      )}
    </DockPanel>
  );
}

function AgentCard({ run, startedBy, onChanged }: { run: RunRow; startedBy?: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
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

  async function send() {
    const body = reply.trim();
    if (!body || sending) return;
    setSending(true);
    setNotice(null);
    try {
      const r = await messageRun(run.id, body);
      setReply('');
      setTranscript(null);
      setNotice({ tone: 'ok', text: r.delivered === 'resumed' ? 'Agent resumed with your message.' : 'Delivered — the agent reads it at its next step.' });
      onChanged();
    } catch (e) {
      setNotice({ tone: 'error', text: (e as Error).message });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-button border border-border bg-bg">
      <div className="flex items-start gap-2 px-2 py-1.5">
        <button onClick={() => setOpen(o => !o)} className="mt-0.5 text-fg-tertiary hover:text-fg" aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-medium text-fg">{run.label}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLE[run.status] ?? ''}`}>{STATUS_LABEL[run.status] ?? run.status}</span>
            <span className="text-fg-tertiary">{run.model}</span>
            <span className="text-fg-tertiary">{tokens.toLocaleString()} tokens</span>
            {startedBy && run.depth > 1 && <span className="text-fg-tertiary">· started by {startedBy}</span>}
          </div>
          <p className={`mt-0.5 text-xs text-fg-secondary ${open ? 'whitespace-pre-wrap' : 'truncate'}`}>{run.goal}</p>
        </div>
        {active && (
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
          <button onClick={() => void toggleTranscript()} className="text-fg-tertiary underline hover:text-fg">
            {transcript === null ? 'Show transcript' : 'Hide transcript'}
          </button>
          {transcript !== null && <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-bg-secondary p-2 font-mono text-[11px] text-fg-secondary">{transcript}</pre>}
        </div>
      )}
      <form
        className="flex gap-1.5 border-t border-border px-2 py-1.5"
        onSubmit={e => { e.preventDefault(); void send(); }}
      >
        <input
          value={reply}
          onChange={e => setReply(e.target.value)}
          placeholder={active ? 'Message this agent…' : 'Reply to resume this agent…'}
          aria-label={`${active ? 'Message' : 'Follow up with'} ${run.label}`}
          className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-xs text-fg outline-none placeholder:text-fg-tertiary focus:border-border-hover"
        />
        <button type="submit" disabled={!reply.trim() || sending} className="rounded p-1.5 text-fg-secondary hover:text-fg disabled:opacity-30" aria-label="Send">
          <Send size={13} />
        </button>
      </form>
      {notice && <p className={`px-2 pb-1.5 text-xs ${notice.tone === 'error' ? 'text-danger' : 'text-success'}`} role="status">{notice.text}</p>}
    </div>
  );
}

/** Compact text rendering of a worker's stored transcript. */
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
