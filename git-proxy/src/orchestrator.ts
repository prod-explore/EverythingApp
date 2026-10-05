// Everything git-proxy needs from the orchestrator (the EverythingApp web/cli server):
//   GET  /internal/github-token?projectId=…   -> { token, expiresAt? }       (credential provider)
//   POST /internal/push-approval              -> { approved, reason? }       (long poll, held until the user decides)
//   POST /internal/audit                      -> 2xx, body ignored           (fire-and-forget)
// All calls carry `Authorization: Bearer <GIT_PROXY_ADMIN_TOKEN>`.
import type { ClassifiedRef } from './push.js';

export type FetchFn = typeof fetch;

export class CredentialError extends Error {}

export interface CredentialProvider {
  getGithubToken(projectId: string): Promise<string>;
}

export interface PushApprovalRequest {
  projectId: string;
  owner: string;
  repo: string;
  refs: ClassifiedRef[];
}

export interface PushApprovalResult {
  approved: boolean;
  reason?: string;
}

export interface Orchestrator {
  requestPushApproval(req: PushApprovalRequest, signal: AbortSignal): Promise<PushApprovalResult>;
  postAudit(event: Record<string, unknown>): void;
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

export class HttpOrchestrator implements Orchestrator {
  private readonly base: string | null;
  constructor(
    orchestratorUrl: string | undefined,
    private readonly adminToken: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.base = orchestratorUrl ? trimSlash(orchestratorUrl) : null;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.adminToken}`, 'content-type': 'application/json' };
  }

  async requestPushApproval(req: PushApprovalRequest, signal: AbortSignal): Promise<PushApprovalResult> {
    if (!this.base) return { approved: false, reason: 'no orchestrator configured to approve pushes' };
    try {
      const res = await this.fetchFn(`${this.base}/internal/push-approval`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(req),
        signal,
      });
      if (!res.ok) return { approved: false, reason: `approval service error (HTTP ${res.status})` };
      const body = (await res.json()) as { approved?: unknown; reason?: unknown };
      return {
        approved: body.approved === true,
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      };
    } catch (err) {
      if (signal.aborted) {
        const r = signal.reason as { name?: string } | undefined;
        return { approved: false, reason: r?.name === 'TimeoutError' ? 'approval timed out' : 'push cancelled' };
      }
      return { approved: false, reason: 'approval service unreachable' };
    }
  }

  postAudit(event: Record<string, unknown>): void {
    if (!this.base) return;
    this.fetchFn(`${this.base}/internal/audit`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    })
      .then(res => res.body?.cancel())
      .catch(() => {
        /* fire-and-forget: stdout already has the record */
      });
  }
}

export interface OrchestratorCredentialOptions {
  orchestratorUrl?: string;
  adminToken: string;
  fallbackPat?: string;
  fetchFn?: FetchFn;
  cacheMs?: number;
  now?: () => number;
}

/**
 * v1 credential provider: ask the orchestrator for the project's GitHub token (OAuth / App installation
 * token), fall back to GITHUB_PAT. Tokens are cached briefly per project.
 */
export class OrchestratorCredentialProvider implements CredentialProvider {
  private readonly cache = new Map<string, { token: string; until: number }>();
  private readonly base: string | null;
  private readonly fetchFn: FetchFn;
  private readonly cacheMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: OrchestratorCredentialOptions) {
    this.base = opts.orchestratorUrl ? trimSlash(opts.orchestratorUrl) : null;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.cacheMs = opts.cacheMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async getGithubToken(projectId: string): Promise<string> {
    const hit = this.cache.get(projectId);
    if (hit && hit.until > this.now()) return hit.token;

    if (this.base) {
      try {
        const res = await this.fetchFn(`${this.base}/internal/github-token?projectId=${encodeURIComponent(projectId)}`, {
          headers: { authorization: `Bearer ${this.opts.adminToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const body = (await res.json()) as { token?: unknown; expiresAt?: unknown };
          if (typeof body.token === 'string' && body.token) {
            let until = this.now() + this.cacheMs;
            if (typeof body.expiresAt === 'string') {
              const exp = Date.parse(body.expiresAt);
              if (!Number.isNaN(exp)) until = Math.min(until, exp - 60_000);
            }
            this.cache.set(projectId, { token: body.token, until });
            return body.token;
          }
        } else {
          await res.body?.cancel();
        }
      } catch {
        /* fall through to the PAT */
      }
    }
    if (this.opts.fallbackPat) return this.opts.fallbackPat;
    throw new CredentialError('no GitHub credentials available for this project (connect GitHub in EverythingApp settings)');
  }
}
