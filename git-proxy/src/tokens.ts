// Short-lived opaque proxy tokens bound to a project and a list of repos. In memory only (v1);
// the map is keyed by sha256(token) so a heap dump doesn't hand out usable tokens.
import { createHash, randomBytes } from 'node:crypto';

export type PushMode = 'allow' | 'ask' | 'deny';
export const PUSH_MODES: readonly PushMode[] = ['allow', 'ask', 'deny'];

export interface RepoGrant {
  owner: string;
  repo: string;
  pushMode: PushMode;
}

export interface TokenBinding {
  projectId: string;
  repos: RepoGrant[];
  expiresAt: number; // epoch ms
}

export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** GitHub owner/repo names are case-insensitive; a trailing `.git` is not part of the name. */
export const normalizeRepo = (name: string): string => name.replace(/\.git$/i, '').toLowerCase();

export class TokenStore {
  private readonly byHash = new Map<string, TokenBinding>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(projectId: string, repos: RepoGrant[], ttlSeconds: number): { token: string; expiresAt: string } {
    const token = `gpx_${randomBytes(32).toString('base64url')}`;
    const expiresAt = this.now() + ttlSeconds * 1000;
    this.byHash.set(hashToken(token), {
      projectId,
      repos: repos.map(r => ({ owner: r.owner, repo: r.repo.replace(/\.git$/i, ''), pushMode: r.pushMode })),
      expiresAt,
    });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** The binding for a live token, or null (unknown or expired — expired ones are dropped). */
  verify(token: string): TokenBinding | null {
    const key = hashToken(token);
    const b = this.byHash.get(key);
    if (!b) return null;
    if (b.expiresAt <= this.now()) {
      this.byHash.delete(key);
      return null;
    }
    return b;
  }

  revoke(token: string): boolean {
    return this.byHash.delete(hashToken(token));
  }

  revokeProject(projectId: string): number {
    let n = 0;
    for (const [k, b] of this.byHash) {
      if (b.projectId === projectId) {
        this.byHash.delete(k);
        n++;
      }
    }
    return n;
  }

  sweep(): number {
    const now = this.now();
    let n = 0;
    for (const [k, b] of this.byHash) {
      if (b.expiresAt <= now) {
        this.byHash.delete(k);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.byHash.size;
  }
}

export function findGrant(binding: TokenBinding, owner: string, repo: string): RepoGrant | undefined {
  const o = owner.toLowerCase();
  const r = normalizeRepo(repo);
  return binding.repos.find(g => g.owner.toLowerCase() === o && normalizeRepo(g.repo) === r);
}
