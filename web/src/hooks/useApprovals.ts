import { useEffect, useMemo, useState } from 'react';
import { approve as apiApprove, getPendingApprovals } from '../api';
import type { ApprovalScope, PendingApproval } from '../types';

const POLL_MS = 2000;

/**
 * server.ts's WebApprovalGate is one instance shared across every
 * conversation (turns run per-conversation and can overlap), and it never
 * pushes an `approval:pending` SSE event — only `approval:resolved` once
 * one is answered (see cli/src/server.ts). So the only way to learn about a
 * NEW pending approval is to ask, and every entry is filtered to this
 * conversation's id so a different conversation's pending approval never
 * shows up here — see web-approval.ts's `conversationId` field.
 */
export function useApprovals(conversationId: string | null): {
  pending: PendingApproval[];
  respond: (id: string, approved: boolean, scope?: ApprovalScope) => Promise<void>;
} {
  // Everything the gate reports; the list for THIS conversation is derived below, so switching conversations
  // never shows (even for one frame) an approval that belongs to the previous one.
  const [all, setAll] = useState<PendingApproval[]>([]);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;

    async function poll() {
      try {
        const { pending: everything } = await getPendingApprovals();
        if (!cancelled) setAll(everything);
      } catch {
        // Transient — next poll retries.
      }
    }

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [conversationId]);

  const pending = useMemo(() => (conversationId ? all.filter(p => p.conversationId === conversationId) : []), [all, conversationId]);

  const respond = async (id: string, approved: boolean, scope?: ApprovalScope) => {
    // Optimistic removal — resolving is fire-and-forget from the UI's
    // perspective; the SSE `approval:resolved` event (if listened to) or the
    // next poll would confirm it either way, so there's nothing to gain by
    // waiting on this request before updating the list.
    setAll(prev => prev.filter(p => p.id !== id));
    await apiApprove(id, approved, scope);
  };

  return { pending, respond };
}
