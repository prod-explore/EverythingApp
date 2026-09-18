import type { ApprovalScope } from '../../types';
import { useApprovals } from '../../hooks/useApprovals';
import { ApprovalModal } from './ApprovalModal';

/**
 * Renders pending tool-call approvals for the current conversation.
 * Dangerous calls go straight to the full ApprovalModal (which forces 'once'
 * scope for dangerous calls). Routine calls also use the modal so the user
 * gets the full scope picker.
 *
 * The banner/inline approach for routine calls has been folded into the modal
 * in Phase 2 — one consistent UX for all approvals.
 */
export function ApprovalBanner({ conversationId }: { conversationId: string }) {
  const { pending, respond } = useApprovals(conversationId);

  // Show the first pending approval as a modal (dangerous ones first so they
  // can't be buried behind a pile of routine approvals).
  const sorted = [...pending].sort((a, b) => (b.dangerous ? 1 : 0) - (a.dangerous ? 1 : 0));
  const current = sorted[0];

  if (!current) return null;

  return (
    <ApprovalModal
      approval={current}
      onRespond={(approved: boolean, scope: ApprovalScope) => respond(current.id, approved, scope)}
    />
  );
}
