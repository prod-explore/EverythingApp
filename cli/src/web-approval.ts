import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  findMatchingGrant,
  createApprovalGrant,
  deleteApprovalGrant,
  listApprovalGrants,
  logApprovalAudit,
  getProject,
  type ApprovalGrantRow,
} from './db.js';
import {
  evaluateCommand,
  extractCommand,
  parseCommandPolicy,
  commandGrantLabel,
  type SubcommandVerdict,
} from './command-policy.js';

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
  /** Shell tools: the per-sub-command verdicts (what the card shows, and which prefixes a non-once approval grants). */
  commands?: SubcommandVerdict[];
  /** Why this call must be approved by hand even though a grant/policy might cover it. */
  warning?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Set when the policy (not a human) refused — shown to the model so it doesn't retry blindly. */
  reason?: string;
}

type ConfirmCtx = {
  projectId?: string; modelId?: string; skillId?: string; timeoutSeconds?: number;
  /** Always prompt (once only), with this warning — e.g. after a suspected prompt injection. */
  forcePrompt?: string;
};

export class WebApprovalGate {
  private readonly db: Database.Database;
  // In-memory only: per-turn skill grants (grantChatScope). Persistent grants live in the DB and are
  // looked up on every confirm() so revocation and model/skill scoping take effect immediately.
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
    ctx?: ConfirmCtx,
  ): Promise<boolean> {
    return (await this.confirmDetailed(conversationId, toolLabel, args, signal, ctx)).approved;
  }

  async confirmDetailed(
    conversationId: string,
    toolLabel: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    ctx?: ConfirmCtx,
  ): Promise<ApprovalDecision> {
    if (signal?.aborted) return { approved: false };
    const dangerous = looksDangerous(args) || !!ctx?.forcePrompt;
    const grantCtx = { conversationId, projectId: ctx?.projectId, modelId: ctx?.modelId, skillId: ctx?.skillId };
    const audit = (action: string) => logApprovalAudit(this.db, { action, toolLabel, toolArgs: JSON.stringify(args), conversationId });

    // Shell commands: classified per sub-command by the project's command policy (Plan v3 §5).
    // A tool-level grant on run_bash deliberately does NOT apply here — that was the hole.
    const command = extractCommand(toolLabel, args);
    let commands: SubcommandVerdict[] | undefined;
    if (command !== null) {
      const project = ctx?.projectId ? getProject(this.db, ctx.projectId) : null;
      const policy = parseCommandPolicy(project?.policy?.['commands']);
      const chatSet = this.chatAllowed.get(conversationId);
      const verdict = evaluateCommand(command, policy, prefix =>
        !!chatSet?.has(commandGrantLabel(prefix)) || !!findMatchingGrant(this.db, commandGrantLabel(prefix), grantCtx));
      if (verdict.decision === 'deny') {
        audit('policy_denied');
        const blocked = verdict.subcommands.filter(s => s.decision === 'deny').map(s => s.command);
        return { approved: false, reason: `blocked by the project command policy: ${blocked.join('; ')}` };
      }
      if (verdict.decision === 'allow' && !dangerous) {
        audit('auto_approved');
        return { approved: true };
      }
      commands = verdict.subcommands;
    } else if (!dangerous) {
      const chatSet = this.chatAllowed.get(conversationId);
      if (chatSet?.has(toolLabel)) return { approved: true };
      if (findMatchingGrant(this.db, toolLabel, grantCtx)) {
        audit('auto_approved');
        return { approved: true };
      }
    }

    const id = randomUUID();
    const timeoutMs = ctx?.timeoutSeconds ? ctx.timeoutSeconds * 1000 : undefined;
    const entry: PendingApproval = { id, conversationId, toolLabel, args, dangerous, createdAt: new Date().toISOString(), timeoutMs, commands, warning: ctx?.forcePrompt };

    return new Promise<ApprovalDecision>(resolve => {
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
        resolve({ approved });
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
      if (scope !== 'once') {
        const projectId = ctx?.projectId ?? null;
        // A project grant without a project id can never match (findMatchingGrant compares ids),
        // so narrow it to this chat instead of storing a dead row.
        const effective = scope === 'project' && !projectId ? 'chat' : scope;
        // A subject needs both halves; a half-filled one would never match either.
        const scoped = ctx?.subjectType && ctx?.subjectId;
        // Shell tools grant the sub-command prefixes the human just saw (never the whole tool).
        const labels = p.entry.commands
          ? [...new Set(p.entry.commands.filter(c => c.decision === 'ask' && c.prefix && c.prefix !== '__SUBST__').map(c => commandGrantLabel(c.prefix)))]
          : [p.entry.toolLabel];
        for (const toolLabel of labels) createApprovalGrant(this.db, {
          toolLabel,
          scope: effective,
          subjectType: scoped ? ctx.subjectType! : null,
          subjectId: scoped ? ctx.subjectId! : null,
          conversationId: effective === 'chat' ? (ctx?.conversationId ?? p.entry.conversationId) : null,
          projectId: effective === 'project' ? projectId : null,
          expiresAt: null,
        });
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
