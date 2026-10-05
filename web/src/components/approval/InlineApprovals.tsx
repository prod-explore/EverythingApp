import { useState } from 'react';
import { AlertTriangle, Shield } from 'lucide-react';
import type { ApprovalScope, PendingApproval } from '../../types';
import { Button } from '../shared/Button';
import { toolLabel } from '../../lib/toolLabels';

type Respond = (id: string, approved: boolean, scope?: ApprovalScope) => Promise<void>;

/** Worker approvals are labelled "[agent researcher] srv/tool" (or "[subagent] …") by the server. */
function splitLabel(label: string): { agent: string | null; tool: string } {
  const m = /^\[(agent ([^\]]+)|subagent)\]\s*/.exec(label);
  return { agent: m ? (m[2] ?? 'subagent') : null, tool: m ? label.slice(m[0].length) : label };
}

function ApprovalCard({ approval, respond }: { approval: PendingApproval; respond: Respond }) {
  const [busy, setBusy] = useState(false);
  const { agent, tool } = splitLabel(approval.toolLabel);
  const friendly = toolLabel(tool.split('/').pop() ?? tool, approval.args, false);
  const danger = approval.dangerous;

  async function answer(approved: boolean, scope: ApprovalScope) {
    setBusy(true);
    try {
      await respond(approval.id, approved, scope);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="group"
      aria-label="Tool call requires approval"
      className={`rounded-container border-2 p-3 text-sm ${danger ? 'border-danger bg-danger/5' : 'border-border bg-bg-secondary'}`}
    >
      <div className={`mb-2 flex items-center gap-2 ${danger ? 'text-danger' : 'text-fg-secondary'}`}>
        {danger ? <AlertTriangle size={16} /> : <Shield size={16} />}
        <span className="font-medium">{danger ? 'Potencjalnie destrukcyjne — tylko jednorazowo' : 'Zgoda na wywołanie narzędzia'}</span>
        {agent && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-xs text-accent">{agent}</span>}
      </div>
      {approval.warning && (
        <p className="mb-2 rounded-button border border-danger/40 bg-danger/5 px-2 py-1.5 text-xs text-danger">{approval.warning}</p>
      )}
      <div className="mb-2 flex items-center gap-2 text-fg">
        <friendly.icon size={14} className="shrink-0" />
        <span className="text-xs">{friendly.label}</span>
        <span className="min-w-0 truncate font-mono text-xs text-fg-tertiary">{tool}</span>
      </div>
      {approval.commands ? (
        <div className="mb-3 max-h-48 space-y-1 overflow-auto rounded-lg bg-bg p-2">
          {approval.commands.map((c, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className={`mt-0.5 shrink-0 rounded px-1.5 font-medium ${c.decision === 'allow' ? 'bg-success/15 text-success' : 'bg-accent/15 text-accent'}`}>
                {c.decision === 'allow' ? 'ok' : 'ask'}
              </span>
              <span className="min-w-0 flex-1">
                <code className="block whitespace-pre-wrap break-all font-mono text-fg">{c.command}</code>
                <span className="text-fg-tertiary">{c.reason}</span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <pre className="mb-3 max-h-40 overflow-auto rounded-lg bg-bg p-2 font-mono text-xs text-fg-secondary">
          {JSON.stringify(approval.args, null, 2)}
        </pre>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void answer(false, 'once')}>Odmów</Button>
        <Button variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={() => void answer(true, 'once')}>
          Zatwierdź raz
        </Button>
        {!danger && (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => void answer(true, 'chat')}>Dla tego czatu</Button>
            <Button variant="ghost" disabled={busy} onClick={() => void answer(true, 'always')}>Zawsze</Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Approval cards pasted into the chat flow (F20); the full-screen modal is only an emergency fallback. */
export function InlineApprovals({ pending, respond }: { pending: PendingApproval[]; respond: Respond }) {
  if (pending.length === 0) return null;
  const sorted = [...pending].sort((a, b) => (b.dangerous ? 1 : 0) - (a.dangerous ? 1 : 0));
  return (
    <div className="space-y-3" aria-live="polite">
      {sorted.map(a => <ApprovalCard key={a.id} approval={a} respond={respond} />)}
    </div>
  );
}
