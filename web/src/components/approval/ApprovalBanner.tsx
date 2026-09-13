import { useApprovals } from '../../hooks/useApprovals';
import { Button } from '../shared/Button';
import { ApprovalModal } from './ApprovalModal';

export function ApprovalBanner({ conversationId }: { conversationId: string }) {
  const { pending, respond } = useApprovals(conversationId);
  const dangerous = pending.filter(p => p.dangerous);
  const routine = pending.filter(p => !p.dangerous);

  return (
    <>
      {dangerous.length > 0 && (
        <ApprovalModal approval={dangerous[0]} onRespond={approved => respond(dangerous[0].id, approved)} />
      )}

      {routine.length > 0 && (
        <div className="absolute inset-x-0 bottom-20 z-40 flex flex-col items-center gap-2 px-4">
          {routine.map(p => (
            <div key={p.id} className="w-full max-w-lg rounded-container border border-border bg-bg-secondary p-4 shadow-2xl">
              <div className="mb-2 font-mono text-sm text-fg">{p.toolLabel}</div>
              <pre className="mb-3 max-h-32 overflow-auto rounded-lg bg-bg p-2 font-mono text-xs text-fg-secondary">
                {JSON.stringify(p.args, null, 2)}
              </pre>
              <div className="flex gap-2">
                <Button variant="ghost" className="flex-1" onClick={() => respond(p.id, false)}>
                  Deny
                </Button>
                <Button variant="primary" className="flex-1" onClick={() => respond(p.id, true)}>
                  Approve
                </Button>
                <Button variant="ghost" className="flex-1" onClick={() => respond(p.id, true, true)}>
                  Always
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
