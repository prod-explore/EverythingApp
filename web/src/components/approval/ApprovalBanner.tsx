import type { ApprovalScope, PendingApproval } from '../../types';
import { ApprovalModal } from './ApprovalModal';

/**
 * Emergency fallback: approvals normally render inline in the chat (InlineApprovals). The modal only
 * takes over while something else covers the chat (Gazeta inbox, Settings), so a pending call can't stall unseen.
 */
export function ApprovalBanner({
  pending,
  respond,
  active,
}: {
  pending: PendingApproval[];
  respond: (id: string, approved: boolean, scope?: ApprovalScope) => Promise<void>;
  /** True when the inline cards are hidden behind another view. */
  active: boolean;
}) {
  if (!active) return null;
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
