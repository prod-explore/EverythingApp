import { randomUUID } from 'node:crypto';

/**
 * Patterns that look potentially irreversible/destructive — §12 pt.5 of the
 * Master Brief. This is a UI hint, not a security boundary (the real
 * boundary is that the call needs a human "y" at all, per §7 pt.3 —
 * enforcement lives outside the model, not in string matching that a
 * determined prompt injection could word around). Deliberately simple and
 * a bit over-eager: false positives just mean an extra warning banner on a
 * safe command, false negatives mean no warning on a genuinely risky one —
 * the asymmetry favors warning too often.
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\b/i, // rm -rf, -fr, -Rf, etc.
  /\bgit\s+push\b.*(--force|-f\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /:\(\)\s*\{\s*:\s*\|\s*:.*\}\s*;\s*:/, // classic shell fork-bomb shape
];

export function looksDangerous(args: Record<string, unknown>): boolean {
  const text = JSON.stringify(args);
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(text));
}

export interface PendingApproval {
  id: string;
  conversationId: string;
  toolLabel: string;
  args: Record<string, unknown>;
  dangerous: boolean;
  createdAt: string;
}

/**
 * confirm() can't block on readline over HTTP — instead it parks a Promise
 * until a separate POST /api/approve resolves it. A tool call with a side
 * effect never runs without an explicit yes from a human, answered from a
 * web page.
 *
 * One instance is shared across every conversation (turns run per
 * conversation and can overlap — see server.ts's per-id turnStates/
 * abortControllers), so every entry carries `conversationId`: without it,
 * a client looking at conversation A has no way to tell a pending approval
 * belongs to conversation B's turn instead, and could approve the wrong one.
 *
 * "Always allow" is scoped per tool, and a call that looks dangerous always
 * re-queues even for an already-"always allowed" tool — approving one never
 * grants future always-allow, since that was granted for routine use, not a
 * specific unseen `--force` push.
 */
export class WebApprovalGate {
  private readonly alwaysAllowed = new Set<string>();
  private readonly pending = new Map<string, { entry: PendingApproval; resolve: (approved: boolean) => void }>();

  async confirm(conversationId: string, toolLabel: string, args: Record<string, unknown>): Promise<boolean> {
    const dangerous = looksDangerous(args);
    if (this.alwaysAllowed.has(toolLabel) && !dangerous) return true;

    const id = randomUUID();
    const entry: PendingApproval = { id, conversationId, toolLabel, args, dangerous, createdAt: new Date().toISOString() };

    return new Promise<boolean>(resolve => {
      this.pending.set(id, {
        entry,
        resolve: approved => {
          this.pending.delete(id);
          resolve(approved);
        },
      });
    });
  }

  listPending(): PendingApproval[] {
    return [...this.pending.values()].map(p => p.entry);
  }

  /** Returns false if `id` doesn't match a currently-pending approval (already resolved, or bogus). */
  resolve(id: string, approved: boolean, alwaysAllow: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    if (approved && alwaysAllow && !p.entry.dangerous) {
      this.alwaysAllowed.add(p.entry.toolLabel);
    }
    p.resolve(approved);
    return true;
  }
}
