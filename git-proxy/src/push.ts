// Push classification (create/update/delete, force detection) and the approval policy.
import { isZeroSha, type RefCommand } from './pktline.js';
import type { CredentialProvider, FetchFn } from './orchestrator.js';
import type { PushMode } from './tokens.js';

export type RefKind = 'create' | 'update' | 'delete';

export interface ClassifiedRef {
  ref: string;
  old: string;
  new: string;
  kind: RefKind;
  /** true = non-fast-forward, false = fast-forward, null = could not be determined (treated cautiously). */
  force: boolean | null;
}

/** Returns GitHub's compare `status` for base...head ("ahead" | "behind" | "diverged" | "identical"), or null if unknown. */
export type CompareFn = (projectId: string, owner: string, repo: string, base: string, head: string) => Promise<string | null>;

export function githubCompare(apiUrl: string, credentials: CredentialProvider, fetchFn: FetchFn = fetch): CompareFn {
  const base = apiUrl.replace(/\/+$/, '');
  return async (projectId, owner, repo, from, to) => {
    try {
      const token = await credentials.getGithubToken(projectId);
      const res = await fetchFn(
        `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${from}...${to}?per_page=1`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'everythingapp-git-proxy',
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok) {
        // 404 is the normal answer when `to` only exists in the pack being pushed.
        await res.body?.cancel();
        return null;
      }
      const body = (await res.json()) as { status?: unknown };
      return typeof body.status === 'string' ? body.status : null;
    } catch {
      return null;
    }
  };
}

export function forceFromCompareStatus(status: string | null): boolean | null {
  if (status === 'ahead' || status === 'identical') return false;
  if (status === 'behind' || status === 'diverged') return true;
  return null;
}

export async function classifyRefs(
  commands: RefCommand[],
  compare: (base: string, head: string) => Promise<string | null>,
): Promise<ClassifiedRef[]> {
  return Promise.all(
    commands.map(async (c): Promise<ClassifiedRef> => {
      if (isZeroSha(c.new)) return { ...c, kind: 'delete', force: false };
      if (isZeroSha(c.old)) return { ...c, kind: 'create', force: false };
      return { ...c, kind: 'update', force: forceFromCompareStatus(await compare(c.old, c.new)) };
    }),
  );
}

export const branchName = (ref: string): string | null => (ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null);

export interface PushDecision {
  action: 'allow' | 'ask' | 'deny';
  reason: string;
}

/**
 * - deny  -> always rejected.
 * - ask   -> always needs approval.
 * - allow -> skips approval, EXCEPT: any delete, any detected force push, and updates of protected branches
 *            whose fast-forwardness could not be verified (force === null).
 */
export function decidePush(mode: PushMode, refs: ClassifiedRef[], protectedBranches: string[]): PushDecision {
  if (mode === 'deny') return { action: 'deny', reason: 'push disabled for this repository' };
  if (mode === 'ask') return { action: 'ask', reason: 'push mode requires approval' };
  const prot = new Set(protectedBranches);
  for (const r of refs) {
    if (r.kind === 'delete') return { action: 'ask', reason: `deletes ${r.ref}` };
    if (r.force === true) return { action: 'ask', reason: `force-push to ${r.ref}` };
    const b = branchName(r.ref);
    if (r.kind === 'update' && r.force === null && b !== null && prot.has(b)) {
      return { action: 'ask', reason: `unverified update of protected branch ${b}` };
    }
  }
  return { action: 'allow', reason: 'push mode allow' };
}
