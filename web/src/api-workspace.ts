import { ApiError, notifyUnauthorized } from './api';
import type {
  Checkpoint, GithubStatus, ProjectRepo, PushMode, ScmBranch, ScmCommit, ScmStatus, WorkspaceListing,
} from './types-workspace';

/** Same contract as api.ts's request(): JSON in/out, session cookie, ApiError on failure. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (res.status === 401) notifyUnauthorized();
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `request failed (${res.status})`, res.status);
  return body as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

// ─── N3: Workspace Explorer + checkpoints ─────────────────────────────────────

export function listWorkspaceFiles(owner: string, path: string): Promise<WorkspaceListing> {
  return request(`/api/workspace/${owner}/files?path=${encodeURIComponent(path)}`);
}

/** Fetches a workspace file; returns a blob URL (caller revokes it) and text for text types. */
export async function fetchWorkspaceFile(owner: string, path: string): Promise<{ url: string; type: string; text?: string; size: number }> {
  const res = await fetch(`/api/workspace/${owner}/file?path=${encodeURIComponent(path)}`);
  if (res.status === 401) notifyUnauthorized();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `request failed (${res.status})`, res.status);
  }
  const blob = await res.blob();
  const type = (res.headers.get('content-type') ?? blob.type ?? 'application/octet-stream').split(';')[0]!;
  return { url: URL.createObjectURL(blob), type, size: blob.size, text: type.startsWith('text/') ? await blob.text() : undefined };
}

export function listCheckpoints(owner: string): Promise<{ checkpoints: Checkpoint[] }> {
  return request(`/api/workspace/${owner}/checkpoints`);
}

export function rollbackWorkspace(owner: string, checkpointId: string): Promise<{ ok: boolean }> {
  return request(`/api/workspace/${owner}/rollback`, post({ checkpointId }));
}

// ─── N4: GitHub connection + repo bindings ────────────────────────────────────

export const githubConnect = {
  status: () => request<GithubStatus>('/api/github/status'),
  startDevice: () => request<{ userCode: string; verificationUri: string; expiresIn: number; interval: number }>('/api/github/device/start', { method: 'POST' }),
  pollDevice: () =>
    request<{ status: 'pending' | 'authorized' | 'denied' | 'expired' | 'error'; interval?: number; login?: string | null; error?: string }>(
      '/api/github/device/poll', { method: 'POST' },
    ),
  setPat: (token: string) => request<{ ok: boolean; login: string | null }>('/api/github/pat', { method: 'PUT', body: JSON.stringify({ token }) }),
  disconnect: () => request<{ ok: boolean }>('/api/github', { method: 'DELETE' }),
};

export const projectRepos = {
  list: (projectId: string) => request<{ repos: ProjectRepo[] }>(`/api/projects/${projectId}/repos`),
  add: (projectId: string, repo: string, pushMode?: PushMode) => request<{ repos: ProjectRepo[] }>(`/api/projects/${projectId}/repos`, post({ repo, pushMode })),
  update: (projectId: string, repoId: string, patch: { pushMode?: PushMode; defaultBranch?: string }) =>
    request<{ repos: ProjectRepo[] }>(`/api/projects/${projectId}/repos/${repoId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (projectId: string, repoId: string) => request<{ ok: boolean }>(`/api/projects/${projectId}/repos/${repoId}`, { method: 'DELETE' }),
};

/** GitHub REST through the server (linked repos only). `path` like `/repos/o/r/pulls?state=open`. */
export function githubApi<T>(projectId: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  return request(`/api/projects/${projectId}/github${path}`, {
    method: init?.method ?? 'GET',
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** Text endpoints (Actions logs, PR diffs) — not JSON. */
export async function githubText(projectId: string, path: string, accept?: string): Promise<string> {
  const res = await fetch(`/api/projects/${projectId}/github${path}`, {
    headers: accept ? { Accept: accept } : {},
  });
  if (res.status === 401) notifyUnauthorized();
  if (!res.ok) throw new ApiError(`request failed (${res.status})`, res.status);
  return res.text();
}

// ─── N4: Source Control (git runs in the project sandbox) ─────────────────────

const qs = (dir: string, extra: Record<string, string> = {}) => new URLSearchParams({ dir, ...extra }).toString();

export const scm = {
  status: (p: string, dir: string) => request<ScmStatus>(`/api/projects/${p}/scm/status?${qs(dir)}`),
  diff: (p: string, dir: string, path: string, staged: boolean) =>
    request<{ diff: string }>(`/api/projects/${p}/scm/diff?${qs(dir, { path, staged: staged ? '1' : '0' })}`),
  stage: (p: string, dir: string, paths: string[]) => request(`/api/projects/${p}/scm/stage`, post({ dir, paths })),
  unstage: (p: string, dir: string, paths: string[]) => request(`/api/projects/${p}/scm/unstage`, post({ dir, paths })),
  discard: (p: string, dir: string, paths: string[]) => request(`/api/projects/${p}/scm/discard`, post({ dir, paths })),
  apply: (p: string, dir: string, patch: string, reverse: boolean) => request(`/api/projects/${p}/scm/apply`, post({ dir, patch, reverse })),
  commit: (p: string, dir: string, message: string, amend: boolean) => request<{ output: string }>(`/api/projects/${p}/scm/commit`, post({ dir, message, amend })),
  branches: (p: string, dir: string) => request<{ branches: ScmBranch[] }>(`/api/projects/${p}/scm/branches?${qs(dir)}`),
  checkout: (p: string, dir: string, branch: string, create: boolean) => request<{ output: string }>(`/api/projects/${p}/scm/checkout`, post({ dir, branch, create })),
  log: (p: string, dir: string, limit = 150) => request<{ commits: ScmCommit[] }>(`/api/projects/${p}/scm/log?${qs(dir, { limit: String(limit) })}`),
  show: (p: string, dir: string, sha: string) => request<{ output: string }>(`/api/projects/${p}/scm/show?${qs(dir, { sha })}`),
  blame: (p: string, dir: string, path: string) => request<{ blame: string }>(`/api/projects/${p}/scm/blame?${qs(dir, { path })}`),
  stash: (p: string, dir: string, action: 'list' | 'push' | 'pop' | 'apply' | 'drop', index?: number, message?: string) =>
    request<{ output: string }>(`/api/projects/${p}/scm/stash`, post({ dir, action, index, message })),
  resolve: (p: string, dir: string, path: string, content: string) => request(`/api/projects/${p}/scm/resolve`, post({ dir, path, content })),
  sync: (p: string, dir: string, action: 'fetch' | 'pull' | 'push' | 'clone', repoId?: string) =>
    request<{ output: string }>(`/api/projects/${p}/scm/sync`, post({ dir, action, repoId })),
};
