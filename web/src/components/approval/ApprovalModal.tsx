import { useEffect, useState } from 'react';
import { AlertTriangle, Shield } from 'lucide-react';
import type { ApprovalScope, PendingApproval } from '../../types';
import { Button } from '../shared/Button';

/**
 * Approval modal with 3-scope picker:
 * - Deny → always just denies (Escape)
 * - Approve → expands a scope picker (Enter = 'once')
 *   - Once (Enter)       — this call only, not remembered
 *   - This chat (C)      — auto-approves this tool for the rest of this conversation
 *   - Always (A)         — auto-approves globally (all conversations, until server restart)
 *
 * For dangerous calls: scope picker is hidden — dangerous calls are always
 * forced to 'once' by the server regardless, and showing the wider options
 * would be misleading (§12 pt.5 of the Master Brief).
 */
export function ApprovalModal({
  approval,
  onRespond,
}: {
  approval: PendingApproval;
  onRespond: (approved: boolean, scope: ApprovalScope) => void;
}) {
  const [scopePickerOpen, setScopePickerOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { onRespond(false, 'once'); return; }
      if (scopePickerOpen) {
        if (e.key === 'Enter') { onRespond(true, 'once'); return; }
        if ((e.key === 'a' || e.key === 'A') && !approval.dangerous) { onRespond(true, 'always'); return; }
        if ((e.key === 'c' || e.key === 'C') && !approval.dangerous) { onRespond(true, 'chat'); return; }
      } else {
        // Enter on the first screen opens scope picker (or approves 'once' directly for dangerous)
        if (e.key === 'Enter') {
          if (approval.dangerous) { onRespond(true, 'once'); } else { setScopePickerOpen(true); }
          return;
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onRespond, scopePickerOpen, approval.dangerous]);

  const dangerBorder = approval.dangerous ? 'border-danger' : 'border-border';
  const dangerBg = approval.dangerous ? 'bg-danger/5' : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div
        className={`w-full max-w-lg rounded-container border-2 ${dangerBorder} ${dangerBg} bg-bg-secondary p-6`}
        role="alertdialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className={`mb-3 flex items-center gap-2 ${approval.dangerous ? 'text-danger' : 'text-fg-secondary'}`}>
          {approval.dangerous ? <AlertTriangle size={20} /> : <Shield size={20} />}
          <h2 className="text-lg font-semibold">
            {approval.dangerous ? 'Potentially destructive — approve once only' : 'Tool call requires approval'}
          </h2>
        </div>

        {/* Tool label + args */}
        <div className="mb-2 font-mono text-sm text-fg">{approval.toolLabel}</div>
        <pre className="mb-4 max-h-48 overflow-auto rounded-lg bg-bg p-3 font-mono text-xs text-fg-secondary">
          {JSON.stringify(approval.args, null, 2)}
        </pre>

        {/* Action area */}
        {!scopePickerOpen ? (
          /* First screen: Deny / Approve */
          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => onRespond(false, 'once')} autoFocus>
              Deny (Esc)
            </Button>
            <Button
              variant={approval.dangerous ? 'danger' : 'primary'}
              className="flex-1"
              onClick={() => {
                if (approval.dangerous) {
                  onRespond(true, 'once');
                } else {
                  setScopePickerOpen(true);
                }
              }}
            >
              {approval.dangerous ? 'Approve once (Enter)' : 'Approve… (Enter)'}
            </Button>
          </div>
        ) : (
          /* Scope picker — only shown for non-dangerous calls */
          <div className="space-y-2">
            <p className="mb-3 text-xs text-fg-tertiary">How long should this approval last?</p>
            <button
              className="w-full rounded-button border border-border bg-bg px-4 py-2 text-left text-sm hover:border-border-hover"
              onClick={() => onRespond(true, 'once')}
              autoFocus
            >
              <span className="font-medium text-fg">Approve once</span>
              <span className="ml-2 text-xs text-fg-tertiary">(Enter) — just this call</span>
            </button>
            <button
              className="w-full rounded-button border border-border bg-bg px-4 py-2 text-left text-sm hover:border-border-hover"
              onClick={() => onRespond(true, 'chat')}
            >
              <span className="font-medium text-fg">Approve for this chat</span>
              <span className="ml-2 text-xs text-fg-tertiary">(C) — rest of this conversation</span>
            </button>
            <button
              className="w-full rounded-button border border-border bg-bg px-4 py-2 text-left text-sm hover:border-border-hover"
              onClick={() => onRespond(true, 'always')}
            >
              <span className="font-medium text-fg">Always approve</span>
              <span className="ml-2 text-xs text-fg-tertiary">(A) — until server restart</span>
            </button>
            <Button variant="ghost" className="mt-1 w-full" onClick={() => onRespond(false, 'once')}>
              Deny (Esc)
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
