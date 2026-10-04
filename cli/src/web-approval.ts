import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  findMatchingGrant,
  createApprovalGrant,
  deleteApprovalGrant,
  listApprovalGrants,
  logApprovalAudit,
  type ApprovalGrantRow,
} from './db.js';

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
  // Browser-agent actions (§6b) — matched against browser_act's required `label` field,
  // which is copied from the page's own visible element text, not written by the model.
  // Same "over-eager on purpose" tradeoff as the patterns above: a false positive is an
  // extra approval prompt, a false negative is an unreviewed destructive click.
  /\b(delete|remove|close|deactivate|cancel)\s+(my\s+)?(account|subscription|membership)\b/i,
  /\b(place|confirm|submit)\s+(the\s+)?order\b/i,
  /\b(buy|purchase)\s+now\b/i,
  /\b(complete|confirm|authorize)\s+payment\b/i,
  /\bpay\s+now\b/i,
  /\bwire\s+transfer\b/i,
  /\bunsubscribe\b/i,
  /\bsend\s+money\b/i,
  /\bdelete\s+(this\s+)?(post|repo|repository|project|file)\b/i,
];

export function looksDangerous(args: Record<string, unknown>): boolean {
  const text = JSON.stringify(args);
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * How broadly a single approval grants future auto-approval:
 * - 'once'   — this specific call only, always re-prompts next time
 * - 'chat'   — auto-approve this tool for the rest of this conversation session
 * - 'project' — auto-approve this tool across all chats for a specific project
 * - 'always' — auto-approve this tool globally (until revoked)
 *
 * Note: dangerous calls are always forced to 'once' regardless of what the
 * client sends — granting 'always' for a tool never covers destructive variants
 * of that tool (§12 pt.5 of the Master Brief).
 */
export type ApprovalScope = 'once' | 'chat' | 'project' | 'always';

export interface PendingApproval {
  id: string;
  conversationId: string;
  toolLabel: string;
  args: Record<string, unknown>;
  dangerous: boolean;
  createdAt: string;
  timeoutMs?: number; // undefined = no timeout
}

export class WebApprovalGate {
  private readonly db: Database.Database;
  private readonly globalAllowed = new Set<string>();
  private readonly chatAllowed = new Map<string, Set<string>>();
  private readonly pending = new Map<string, { entry: PendingApproval; resolve: (approved: boolean) => void; timer?: ReturnType<typeof setTimeout> }>();

  constructor(db: Database.Database) {
    this.db = db;
  }

  async confirm(
    conversationId: string,
    toolLabel: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    ctx?: { projectId?: string; modelId?: string; skillId?: string; timeoutSeconds?: number },
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const dangerous = looksDangerous(args);
    if (!dangerous) {
      if (this.globalAllowed.has(toolLabel)) return true;
      const chatSet = this.chatAllowed.get(conversationId);
      if (chatSet?.has(toolLabel)) return true;

      const match = findMatchingGrant(this.db, {
        toolLabel,
        conversationId,
        projectId: ctx?.projectId,
        modelId: ctx?.modelId,
        skillId: ctx?.skillId,
      });

      if (match) {
        logApprovalAudit(this.db, {
          action: 'auto_approved',
          toolLabel,
          toolArgs: JSON.stringify(args),
          conversationId,
        });
        return true;
      }
    }

    const id = randomUUID();
    const timeoutMs = ctx?.timeoutSeconds ? ctx.timeoutSeconds * 1000 : undefined;
    const entry: PendingApproval = { id, conversationId, toolLabel, args, dangerous, createdAt: new Date().toISOString(), timeoutMs };

    return new Promise<boolean>(resolve => {
      const onAbort = () => settle(false);
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (approved: boolean) => {
        signal?.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        logApprovalAudit(this.db, {
          action: approved ? 'granted' : 'denied',
          toolLabel,
          toolArgs: JSON.stringify(args),
          conversationId,
        });
        resolve(approved);
      };

      if (timeoutMs) {
        timer = setTimeout(() => settle(false), timeoutMs);
      }
      this.pending.set(id, { entry, resolve: settle, timer });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private grantChatScopeInMemory(conversationId: string, toolLabel: string): void {
    let chatSet = this.chatAllowed.get(conversationId);
    if (!chatSet) {
      chatSet = new Set();
      this.chatAllowed.set(conversationId, chatSet);
    }
    chatSet.add(toolLabel);
  }

  grantChatScope(conversationId: string, toolLabel: string): void {
    // In-memory only — skill per-turn grants aren't persisted (they expire after the turn)
    this.grantChatScopeInMemory(conversationId, toolLabel);
  }

  listPending(): PendingApproval[] {
    return [...this.pending.values()].map(p => p.entry);
  }

  resolve(
    id: string,
    approved: boolean,
    scope: ApprovalScope = 'once',
    ctx?: { conversationId?: string; projectId?: string; subjectType?: 'model' | 'skill'; subjectId?: string },
  ): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    if (approved && !p.entry.dangerous) {
      if (scope === 'always' || scope === 'project' || scope === 'chat') {
        // Persist to DB
        createApprovalGrant(this.db, {
          toolLabel: p.entry.toolLabel,
          scope: scope === 'once' ? 'always' : scope, // 'once' never reaches here
          subjectType: ctx?.subjectType ?? null,
          subjectId: ctx?.subjectId ?? null,
          conversationId: scope === 'chat' ? (ctx?.conversationId ?? p.entry.conversationId) : null,
          projectId: scope === 'project' ? (ctx?.projectId ?? null) : null,
          expiresAt: null,
        });
      }
      // Keep in-memory cache too for performance (within the session)
      if (scope === 'always') {
        this.globalAllowed.add(p.entry.toolLabel);
      } else if (scope === 'chat') {
        this.grantChatScopeInMemory(p.entry.conversationId, p.entry.toolLabel);
      }
    }
    p.resolve(approved);
    return true;
  }

  /** Returns all persisted grants (from DB), optionally filtered. */
  listGrants(filter?: { conversationId?: string; projectId?: string; scope?: string }): ApprovalGrantRow[] {
    return listApprovalGrants(this.db, filter);
  }

  /** Revokes a persisted grant by ID. */
  revokeGrant(grantId: string): boolean {
    const deleted = deleteApprovalGrant(this.db, grantId);
    if (deleted) {
      logApprovalAudit(this.db, { grantId, action: 'revoked', toolLabel: '(revoked)' });
    }
    return deleted;
  }
}
