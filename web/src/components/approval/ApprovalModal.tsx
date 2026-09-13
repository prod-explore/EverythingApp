import { useEffect } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { PendingApproval } from '../../types';
import { Button } from '../shared/Button';

export function ApprovalModal({
  approval,
  onRespond,
}: {
  approval: PendingApproval;
  onRespond: (approved: boolean) => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Enter') onRespond(true);
      if (e.key === 'Escape') onRespond(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onRespond]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-lg rounded-container border-2 border-danger bg-bg-secondary p-6" role="alertdialog" aria-modal="true">
        <div className="mb-3 flex items-center gap-2 text-danger">
          <TriangleAlert size={20} />
          <h2 className="text-lg font-semibold">Looks risky or irreversible</h2>
        </div>
        <div className="mb-2 font-mono text-sm text-fg">{approval.toolLabel}</div>
        <pre className="mb-4 max-h-48 overflow-auto rounded-lg bg-bg p-3 font-mono text-xs text-fg-secondary">
          {JSON.stringify(approval.args, null, 2)}
        </pre>
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={() => onRespond(false)} autoFocus>
            Deny (Esc)
          </Button>
          <Button variant="danger" className="flex-1" onClick={() => onRespond(true)}>
            Approve (Enter)
          </Button>
        </div>
      </div>
    </div>
  );
}
