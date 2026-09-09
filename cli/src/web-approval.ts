import { randomUUID } from 'node:crypto';
import { looksDangerous } from './approval.js';

export interface PendingApproval {
  id: string;
  toolLabel: string;
  args: Record<string, unknown>;
  dangerous: boolean;
  createdAt: string;
}

/**
 * Same contract as ApprovalGate (terminal), but confirm() can't block on
 * readline over HTTP — instead it parks a Promise until a separate
 * POST /api/approve resolves it. A tool call with a side effect still never
 * runs without an explicit yes from a human; the human just answers from a
 * web page instead of a terminal.
 *
 * Same "always allow" + dangerous-call override as the terminal gate — see
 * approval.ts for the reasoning. Deliberately reuses looksDangerous() rather
 * than a second copy of the pattern list.
 */
export class WebApprovalGate {
  private readonly alwaysAllowed = new Set<string>();
  private readonly pending = new Map<string, { entry: PendingApproval; resolve: (approved: boolean) => void }>();

  async confirm(toolLabel: string, args: Record<string, unknown>): Promise<boolean> {
    const dangerous = looksDangerous(args);
    if (this.alwaysAllowed.has(toolLabel) && !dangerous) return true;

    const id = randomUUID();
    const entry: PendingApproval = { id, toolLabel, args, dangerous, createdAt: new Date().toISOString() };

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
