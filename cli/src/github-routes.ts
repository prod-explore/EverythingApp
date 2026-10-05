import express from 'express';
import type Database from 'better-sqlite3';
import { timingSafeEqual } from 'node:crypto';
import type { WebApprovalGate } from './web-approval.js';
import { GitHubCredentials, classifyGithubPath } from './github.js';
import { shq, type SandboxExec } from './supervisor-client.js';
import { getProject, listProjectConversations, logApprovalAudit } from './db.js';

/**
 * N4 — GitHub without functional limits (Plan v3 §7), orchestrator side:
 *   - credentials: GitHub App device flow / fine-grained PAT (github.ts), never sent to the sandbox
 *   - project ↔ repo bindings (project_repos) that git-proxy enforces
 *   - /internal/* for git-proxy: credential injection, push approval cards, audit
 *   - sandbox git wiring: a short-lived proxy token + `insteadOf` rewrite configured INSIDE the sandbox
 *   - GitHub REST proxy for the human panel (PRs, issues, checks, Actions), limited to bound repos
 *   - Source Control: git runs inside the project sandbox (status, diff, stage incl. hunks, commit,
 *     branches, log graph, blame, stash, conflicts). Host never runs git.
 */

export interface ProjectRepo {
  id: string;
  projectId: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  pushMode: 'ask' | 'allow' | 'deny';
  createdAt: string;
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const PUSH_MODES = new Set(['ask', 'allow', 'deny']);

export function listProjectRepos(db: Database.Database, projectId: string): ProjectRepo[] {
  return (db.prepare(`SELECT * FROM project_repos WHERE project_id = ? ORDER BY created_at`).all(projectId) as Record<string, string>[]).map(r => ({
    id: r['id']!, projectId: r['project_id']!, owner: r['owner']!, repo: r['repo']!,
    defaultBranch: r['default_branch']!, pushMode: r['push_mode'] as ProjectRepo['pushMode'], createdAt: r['created_at']!,
  }));
}

function sameRepo(a: { owner: string; repo: string }, owner: string, repo: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\.git$/, '');
  return norm(a.owner) === norm(owner) && norm(a.repo) === norm(repo);
}

function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface GithubRoutesDeps {
  db: Database.Database;
  approvalGate: WebApprovalGate;
  credentials: GitHubCredentials;
  sandbox: SandboxExec;
  /** Most recently active chat of a project — where push approval cards are shown. */
  activeConversationFor: (projectId: string) => string | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/** Push approval cards for pushes a human just clicked in Source Control are skipped (Plan v3 §7.3). */
interface ExpectedPush { projectId: string; owner: string; repo: string; until: number }

export function createGithubRoutes(deps: GithubRoutesDeps) {
  const { db, approvalGate, credentials, sandbox } = deps;
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const adminToken = env['GIT_PROXY_ADMIN_TOKEN'];
  const proxyUrl = env['GIT_PROXY_URL'] ?? 'http://git-proxy:8080';
  /** URL git inside the sandbox uses to reach the proxy (bridge gateway / published port). */
  const proxyUrlForSandbox = env['GIT_PROXY_SANDBOX_URL'] ?? proxyUrl;
  const expectedPushes: ExpectedPush[] = [];
  const sandboxTokens = new Map<string, { token: string; expiresAt: number; reposKey: string }>();

  // ─── Internal (git-proxy → orchestrator), mounted BEFORE the user auth middleware ──────
  const internal = express.Router();
  internal.use((req, res, next) => {
    if (!bearerMatches(req.headers.authorization, adminToken)) { res.status(401).json({ error: 'unauthorized' }); return; }
    next();
  });

  internal.get('/github-token', async (req, res) => {
    const projectId = typeof req.query['projectId'] === 'string' ? req.query['projectId'] : '';
    if (!projectId || !getProject(db, projectId)) { res.status(404).json({ error: 'unknown project' }); return; }
    const token = await credentials.getToken();
    if (!token) { res.status(404).json({ error: 'GitHub is not connected' }); return; }
    res.json({ token });
  });

  internal.post('/push-approval', async (req, res) => {
    const { projectId, owner, repo, refs } = (req.body ?? {}) as {
      projectId?: string; owner?: string; repo?: string;
      refs?: Array<{ ref: string; old: string; new: string; kind: 'create' | 'update' | 'delete'; force: boolean | null }>;
    };
    if (!projectId || !owner || !repo || !Array.isArray(refs) || refs.length === 0) { res.status(400).json({ error: 'bad request' }); return; }
    const binding = listProjectRepos(db, projectId).find(r => sameRepo(r, owner, repo));
    if (!binding) { res.json({ approved: false, reason: 'repository is not linked to this project' }); return; }
    const risky = refs.some(r => r.kind === 'delete' || r.force === true);

    const now = Date.now();
    const expected = expectedPushes.findIndex(e => e.projectId === projectId && sameRepo(e, owner, repo) && e.until > now);
    if (expected >= 0 && !risky) {
      expectedPushes.splice(expected, 1);
      logApprovalAudit(db, { action: 'push_user_initiated', toolLabel: `git push ${owner}/${repo}`, toolArgs: JSON.stringify(refs) });
      res.json({ approved: true });
      return;
    }

    const convId = deps.activeConversationFor(projectId);
    if (!convId) { res.json({ approved: false, reason: 'no chat in this project to show the approval in' }); return; }
    const refNames = refs.map(r => r.ref.replace(/^refs\/heads\//, '')).join(', ');
    const label = `git push ${owner}/${repo}:${refNames}`;
    const args = {
      repository: `${owner}/${repo}`,
      refs: refs.map(r => ({
        ref: r.ref, kind: r.kind, from: r.old.slice(0, 10), to: r.new.slice(0, 10),
        force: r.force === null ? 'possibly (could not verify)' : r.force,
      })),
    };
    // A git client that disconnects withdraws the card.
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const decision = await approvalGate.confirmDetailed(convId, label, args, controller.signal, {
      projectId,
      forcePrompt: risky ? 'This push deletes a branch or rewrites history (force push).' : undefined,
    });
    if (!res.writableEnded) res.json({ approved: decision.approved, reason: decision.reason ?? (decision.approved ? undefined : 'denied by the user') });
  });

  internal.post('/audit', (req, res) => {
    const e = (req.body ?? {}) as Record<string, unknown>;
    if (e['type'] === 'push_decision' || e['type'] === 'token_minted' || e['type'] === 'tokens_revoked') {
      logApprovalAudit(db, { action: `git_proxy:${String(e['type'])}`, toolLabel: `git ${String(e['owner'] ?? '')}/${String(e['repo'] ?? '')}`, toolArgs: JSON.stringify(e).slice(0, 4000) });
    }
    res.status(204).end();
  });

  // ─── User API (behind the normal auth middleware) ────────────────────────────────────
  const api = express.Router();

  api.get('/github/status', async (_req, res) => {
    res.json(await credentials.status());
  });
  api.post('/github/device/start', async (_req, res) => {
    try { res.json(await credentials.startDeviceFlow()); } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });
  api.post('/github/device/poll', async (_req, res) => {
    res.json(await credentials.pollDeviceFlow());
  });
  api.put('/github/pat', async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    try { res.json({ ok: true, ...(await credentials.setPat(token)) }); } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });
  api.delete('/github', (_req, res) => {
    credentials.disconnect();
    sandboxTokens.clear();
    res.json({ ok: true });
  });

  // Project ↔ repo bindings
  api.get('/projects/:id/repos', (req, res) => {
    if (!getProject(db, req.params.id)) { res.status(404).json({ error: 'project not found' }); return; }
    res.json({ repos: listProjectRepos(db, req.params.id) });
  });
  api.post('/projects/:id/repos', (req, res) => {
    if (!getProject(db, req.params.id)) { res.status(404).json({ error: 'project not found' }); return; }
    let { owner, repo } = (req.body ?? {}) as { owner?: string; repo?: string };
    const { defaultBranch, pushMode } = (req.body ?? {}) as { defaultBranch?: string; pushMode?: string };
    // Accept "owner/repo" or a GitHub URL in `repo`.
    const m = /(?:github\.com[/:])?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repo ?? '');
    if (!owner && m) { owner = m[1]; repo = m[2]; }
    if (!owner || !repo || !NAME_RE.test(owner) || !NAME_RE.test(repo)) { res.status(400).json({ error: 'expected owner/repo' }); return; }
    if (pushMode !== undefined && !PUSH_MODES.has(pushMode)) { res.status(400).json({ error: 'pushMode must be ask | allow | deny' }); return; }
    try {
      db.prepare(`INSERT INTO project_repos (project_id, owner, repo, default_branch, push_mode) VALUES (?, ?, ?, ?, ?)`)
        .run(req.params.id, owner, repo, defaultBranch && /^[\w./-]{1,200}$/.test(defaultBranch) ? defaultBranch : 'main', pushMode ?? 'ask');
    } catch {
      res.status(409).json({ error: 'repository already linked' });
      return;
    }
    sandboxTokens.delete(req.params.id); // repo set changed → next wiring mints a new token
    res.status(201).json({ repos: listProjectRepos(db, req.params.id) });
  });
  api.patch('/projects/:id/repos/:repoId', (req, res) => {
    const { pushMode, defaultBranch } = (req.body ?? {}) as { pushMode?: string; defaultBranch?: string };
    if (pushMode !== undefined && !PUSH_MODES.has(pushMode)) { res.status(400).json({ error: 'pushMode must be ask | allow | deny' }); return; }
    const r = db.prepare(`UPDATE project_repos SET push_mode = COALESCE(?, push_mode), default_branch = COALESCE(?, default_branch) WHERE id = ? AND project_id = ?`)
      .run(pushMode ?? null, defaultBranch && /^[\w./-]{1,200}$/.test(defaultBranch) ? defaultBranch : null, req.params.repoId, req.params.id);
    if (!r.changes) { res.status(404).json({ error: 'not found' }); return; }
    sandboxTokens.delete(req.params.id);
    res.json({ repos: listProjectRepos(db, req.params.id) });
  });
  api.delete('/projects/:id/repos/:repoId', (req, res) => {
    const r = db.prepare(`DELETE FROM project_repos WHERE id = ? AND project_id = ?`).run(req.params.repoId, req.params.id);
    if (!r.changes) { res.status(404).json({ error: 'not found' }); return; }
    sandboxTokens.delete(req.params.id);
    res.json({ ok: true });
  });

  // GitHub REST proxy for the panel — bound repos (or account-level reads) only.
  api.all('/projects/:id/github/*rest', express.json(), async (req, res) => {
    const rest = (req.params as unknown as { rest?: string[] | string }).rest;
    const path = '/' + (Array.isArray(rest) ? rest.join('/') : String(rest ?? ''));
    const target = classifyGithubPath(path);
    if (!target) { res.status(400).json({ error: 'path not allowed' }); return; }
    if (target.kind === 'repo' && !listProjectRepos(db, req.params.id).some(r => sameRepo(r, target.owner, target.repo))) {
      res.status(403).json({ error: 'repository is not linked to this project' });
      return;
    }
    if (target.kind === 'account' && req.method !== 'GET') { res.status(405).json({ error: 'read-only' }); return; }
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) { res.status(405).end(); return; }
    const token = await credentials.getToken();
    if (!token) { res.status(409).json({ error: 'GitHub is not connected' }); return; }
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const upstream = await doFetch(`${credentials.apiBase}${path}${qs}`, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: typeof req.headers.accept === 'string' && req.headers.accept.includes('github') ? req.headers.accept : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'EverythingApp',
        ...(req.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: req.method !== 'GET' && req.method !== 'DELETE' ? JSON.stringify(req.body ?? {}) : undefined,
      redirect: 'follow',
    });
    // Log downloads (Actions logs) redirect to signed storage URLs — `follow` resolves them server-side.
    res.status(upstream.status);
    const type = upstream.headers.get('content-type') ?? 'application/json';
    res.setHeader('Content-Type', type.includes('json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const link = upstream.headers.get('link');
    if (link) res.setHeader('X-GitHub-Link', link);
    if (req.method !== 'GET') {
      logApprovalAudit(db, { action: 'github_api_user', toolLabel: `${req.method} ${path}`, toolArgs: JSON.stringify(req.body ?? {}).slice(0, 2000) });
    }
    res.send(Buffer.from(await upstream.arrayBuffer()));
  });

  // ─── Source Control (git in the sandbox) ──────────────────────────────────────────
  const owner = (projectId: string) => projectId;

  function repoDir(raw: unknown): string | null {
    const d = typeof raw === 'string' ? raw.replace(/^\/workspace\/?/, '').replace(/\/+$/, '') : '';
    if (d === '') return '/workspace';
    if (d.split('/').some(seg => seg === '..' || seg === '' || !/^[\w.@+-]+$/.test(seg))) return null;
    return `/workspace/${d}`;
  }
  const safePath = (p: unknown) => (typeof p === 'string' && p && !p.startsWith('/') && !p.split('/').includes('..') ? p : null);

  async function git(projectId: string, dir: string, args: string, timeoutMs = 60_000) {
    const r = await sandbox.exec(owner(projectId), `cd ${shq(dir)} && git -c core.quotepath=off -c color.ui=never ${args}`, timeoutMs);
    return r;
  }

  const scm = express.Router({ mergeParams: true });
  scm.use((req, res, next) => {
    const p = getProject(db, (req.params as { id: string }).id);
    if (!p) { res.status(404).json({ error: 'project not found' }); return; }
    const dir = repoDir(req.query['dir'] ?? req.body?.dir);
    if (!dir) { res.status(400).json({ error: 'invalid repository directory' }); return; }
    res.locals['dir'] = dir;
    next();
  });
  const run = (handler: (projectId: string, dir: string, req: express.Request) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response) => {
      try {
        res.json(await handler((req.params as { id: string }).id, res.locals['dir'] as string, req));
      } catch (err) {
        res.status(502).json({ error: (err as Error).message });
      }
    };
  const ok = (r: { exitCode: number; stdout: string; stderr: string }) => {
    if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 4000) || `git exited with ${r.exitCode}`);
    return r.stdout;
  };

  scm.get('/status', run(async (id, dir) => {
    const out = ok(await git(id, dir, 'status --porcelain=v1 -b -z --untracked-files=all'));
    return parseStatus(out);
  }));
  scm.get('/diff', run(async (id, dir, req) => {
    const p = req.query['path'] ? safePath(req.query['path']) : '';
    if (p === null) throw new Error('invalid path');
    const staged = req.query['staged'] === '1' ? '--cached ' : '';
    return { diff: ok(await git(id, dir, `diff ${staged}--no-ext-diff -U3 -- ${p ? shq(p) : '.'}`)) };
  }));
  scm.post('/stage', run(async (id, dir, req) => {
    const paths = (Array.isArray(req.body?.paths) ? req.body.paths : []).map(safePath);
    if (!paths.length || paths.includes(null)) throw new Error('invalid paths');
    ok(await git(id, dir, `add -A -- ${paths.map((p: string) => shq(p)).join(' ')}`));
    return { ok: true };
  }));
  scm.post('/unstage', run(async (id, dir, req) => {
    const paths = (Array.isArray(req.body?.paths) ? req.body.paths : []).map(safePath);
    if (!paths.length || paths.includes(null)) throw new Error('invalid paths');
    ok(await git(id, dir, `restore --staged -- ${paths.map((p: string) => shq(p)).join(' ')}`));
    return { ok: true };
  }));
  // Hunk staging: the UI sends a minimal patch; applied to the index via base64 (no quoting pitfalls).
  scm.post('/apply', run(async (id, dir, req) => {
    const patch = typeof req.body?.patch === 'string' ? req.body.patch : '';
    if (!patch || patch.length > 1_000_000) throw new Error('invalid patch');
    const reverse = req.body?.reverse === true ? '--reverse ' : '';
    const b64 = Buffer.from(patch.endsWith('\n') ? patch : patch + '\n').toString('base64');
    const r = await sandbox.exec(owner(id), `cd ${shq(dir)} && echo ${shq(b64)} | base64 -d | git apply --cached ${reverse}--unidiff-zero -`, 60_000);
    ok(r);
    return { ok: true };
  }));
  scm.post('/discard', run(async (id, dir, req) => {
    const paths = (Array.isArray(req.body?.paths) ? req.body.paths : []).map(safePath);
    if (!paths.length || paths.includes(null)) throw new Error('invalid paths');
    const q = paths.map((p: string) => shq(p)).join(' ');
    ok(await git(id, dir, `checkout -- ${q} 2>/dev/null || git clean -f -- ${q}`));
    return { ok: true };
  }));
  scm.post('/commit', run(async (id, dir, req) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) throw new Error('commit message required');
    const amend = req.body?.amend === true ? '--amend ' : '';
    const identity = gitIdentity(id);
    return { output: ok(await git(id, dir, `${identity}commit ${amend}-m ${shq(message)}`)) };
  }));
  scm.get('/branches', run(async (id, dir) => {
    const out = ok(await git(id, dir, `branch -a --format=${shq('%(HEAD)%09%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(objectname:short)')}`));
    return {
      branches: out.split('\n').filter(Boolean).map(l => {
        const [head, name, upstream, track, sha] = l.split('\t');
        return { current: head === '*', name, upstream: upstream || null, track: track || null, sha };
      }),
    };
  }));
  scm.post('/checkout', run(async (id, dir, req) => {
    const branch = typeof req.body?.branch === 'string' ? req.body.branch : '';
    if (!/^[\w./-]{1,200}$/.test(branch) || branch.startsWith('-')) throw new Error('invalid branch name');
    const create = req.body?.create === true ? '-b ' : '';
    return { output: ok(await git(id, dir, `checkout ${create}${shq(branch)}`)) };
  }));
  scm.get('/log', run(async (id, dir, req) => {
    const limit = Math.min(Math.max(Number(req.query['limit'] ?? 100) || 100, 1), 500);
    const fmt = '%x1e%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s';
    const out = ok(await git(id, dir, `log --all --topo-order -n ${limit} --format=${shq(fmt)}`));
    return {
      commits: out.split('\x1e').slice(1).map(rec => {
        const [sha, parents, author, date, refs, subject] = rec.replace(/\n$/, '').split('\x1f');
        return { sha, parents: parents ? parents.split(' ') : [], author, date, refs: refs ? refs.split(', ') : [], subject };
      }),
    };
  }));
  scm.get('/blame', run(async (id, dir, req) => {
    const p = safePath(req.query['path']);
    if (!p) throw new Error('invalid path');
    return { blame: ok(await git(id, dir, `blame --line-porcelain -- ${shq(p)}`)).slice(0, 2_000_000) };
  }));
  scm.post('/stash', run(async (id, dir, req) => {
    const action = req.body?.action;
    const index = Number.isInteger(req.body?.index) ? `stash@{${req.body.index}}` : '';
    const cmd = action === 'push' ? `stash push -u${typeof req.body?.message === 'string' ? ` -m ${shq(req.body.message)}` : ''}`
      : action === 'pop' ? `stash pop ${index}` : action === 'drop' ? `stash drop ${index}` : action === 'apply' ? `stash apply ${index}` : 'stash list';
    return { output: ok(await git(id, dir, cmd)) };
  }));
  // Conflict editor: write the resolved content (base64) and mark resolved.
  scm.post('/resolve', run(async (id, dir, req) => {
    const p = safePath(req.body?.path);
    const content = typeof req.body?.content === 'string' ? req.body.content : null;
    if (!p || content === null) throw new Error('path and content required');
    const b64 = Buffer.from(content).toString('base64');
    ok(await sandbox.exec(owner(id), `cd ${shq(dir)} && echo ${shq(b64)} | base64 -d > ${shq(p)} && git add -- ${shq(p)}`));
    return { ok: true };
  }));
  scm.get('/show', run(async (id, dir, req) => {
    const sha = typeof req.query['sha'] === 'string' && /^[0-9a-f]{4,40}$/.test(req.query['sha']) ? req.query['sha'] : null;
    if (!sha) throw new Error('invalid sha');
    return { output: ok(await git(id, dir, `show --stat --patch --format=fuller ${sha}`)).slice(0, 2_000_000) };
  }));
  // Network operations go through git-proxy; a human-initiated push skips the approval card (§7.3).
  scm.post('/sync', run(async (id, dir, req) => {
    const action = req.body?.action;
    if (action !== 'fetch' && action !== 'pull' && action !== 'push' && action !== 'clone') throw new Error('action must be fetch | pull | push | clone');
    await ensureSandboxGit(id);
    if (action === 'clone') {
      const repo = listProjectRepos(db, id).find(r => r.id === req.body?.repoId);
      if (!repo) throw new Error('unknown repository');
      const r = await sandbox.exec(owner(id), `cd /workspace && git clone https://github.com/${repo.owner}/${repo.repo}.git ${shq(repo.repo)}`, 600_000);
      return { output: ok(r) + r.stderr };
    }
    if (action === 'push') {
      const remote = ok(await git(id, dir, 'remote get-url origin')).trim();
      const m = /github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?$/.exec(remote);
      if (m) expectedPushes.push({ projectId: id, owner: m[1]!, repo: m[2]!, until: Date.now() + 120_000 });
      const r = await git(id, dir, 'push -u origin HEAD', 600_000);
      return { output: ok(r) + r.stderr };
    }
    const r = await git(id, dir, action === 'pull' ? 'pull --ff-only' : 'fetch --all --prune', 600_000);
    return { output: ok(r) + r.stderr };
  }));
  api.use('/projects/:id/scm', scm);

  api.post('/projects/:id/git/wire', async (req, res) => {
    try { res.json(await ensureSandboxGit(req.params.id)); } catch (err) { res.status(502).json({ error: (err as Error).message }); }
  });

  function gitIdentity(projectId: string): string {
    const p = getProject(db, projectId);
    const g = (p?.policy?.['git'] ?? {}) as { name?: string; email?: string };
    const name = typeof g.name === 'string' && g.name.trim() ? g.name.trim() : 'EverythingApp';
    const email = typeof g.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(g.email) ? g.email : 'agent@everythingapp.local';
    return `-c user.name=${shq(name)} -c user.email=${shq(email)} `;
  }

  /**
   * Mints a short-lived proxy token for the project's bound repos and configures git INSIDE the sandbox
   * to use git-proxy for github.com (HTTPS and SSH forms). The token is opaque and useless outside the
   * proxy; the real GitHub credential never enters the sandbox (Plan v3 invariant 2).
   */
  async function ensureSandboxGit(projectId: string): Promise<{ wired: boolean; repos: number; reason?: string }> {
    const repos = listProjectRepos(db, projectId);
    if (!repos.length) return { wired: false, repos: 0, reason: 'no repositories linked to this project' };
    if (!adminToken) return { wired: false, repos: repos.length, reason: 'GIT_PROXY_ADMIN_TOKEN is not configured' };
    const reposKey = repos.map(r => `${r.owner}/${r.repo}:${r.pushMode}`).join(',');
    const cached = sandboxTokens.get(projectId);
    if (cached && cached.reposKey === reposKey && cached.expiresAt - Date.now() > 10 * 60_000) return { wired: true, repos: repos.length };

    const minted = await doFetch(`${proxyUrl.replace(/\/$/, '')}/admin/tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, repos: repos.map(r => ({ owner: r.owner, repo: r.repo, pushMode: r.pushMode })), ttlSeconds: 4 * 3600 }),
    });
    if (!minted.ok) throw new Error(`git-proxy refused to mint a token (${minted.status})`);
    const { token, expiresAt } = (await minted.json()) as { token: string; expiresAt: string };
    if (!/^[\w-]+$/.test(token)) throw new Error('unexpected token format from git-proxy');
    const base = new URL(proxyUrlForSandbox);
    const authed = `${base.protocol}//x-token:${token}@${base.host}${base.pathname.replace(/\/$/, '')}/`;
    const cfg = [
      // Drop earlier rewrites (old tokens) first.
      `for k in $(git config --global --name-only --get-regexp '^url\\..*\\.insteadof$' 2>/dev/null | sort -u); do git config --global --remove-section "\${k%.insteadof}" 2>/dev/null; done`,
      `git config --global url.${shq(authed)}.insteadOf https://github.com/`,
      `git config --global --add url.${shq(authed)}.insteadOf git@github.com:`,
      `git config --global --add url.${shq(authed)}.insteadOf ssh://git@github.com/`,
      `git config --global credential.helper ''`,
    ].join(' && ');
    const r = await sandbox.exec(owner(projectId), cfg, 30_000);
    if (r.exitCode !== 0) throw new Error(`could not configure git in the sandbox: ${r.stderr.trim()}`);
    sandboxTokens.set(projectId, { token, expiresAt: Date.parse(expiresAt), reposKey });
    return { wired: true, repos: repos.length };
  }

  return { internal, api, ensureSandboxGit };
}

export interface StatusEntry {
  path: string;
  origPath?: string;
  /** Index (staged) and work-tree status letters, as in `git status --porcelain`. */
  index: string;
  worktree: string;
  conflicted: boolean;
}

/** Parses `git status --porcelain=v1 -b -z`. */
export function parseStatus(out: string): { branch: string | null; upstream: string | null; ahead: number; behind: number; files: StatusEntry[] } {
  const parts = out.split('\0');
  let branch: string | null = null, upstream: string | null = null, ahead = 0, behind = 0;
  const files: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]!;
    if (!rec) continue;
    if (rec.startsWith('## ')) {
      const m = /^## (?:No commits yet on )?([^.\s]+(?:\.(?!\.)[^.\s]*)*)(?:\.\.\.(\S+))?(?: \[(.*)\])?/.exec(rec);
      branch = m?.[1] ?? null;
      upstream = m?.[2] ?? null;
      const a = /ahead (\d+)/.exec(m?.[3] ?? ''); const b = /behind (\d+)/.exec(m?.[3] ?? '');
      ahead = a ? Number(a[1]) : 0; behind = b ? Number(b[1]) : 0;
      continue;
    }
    const x = rec[0]!, y = rec[1]!, path = rec.slice(3);
    const entry: StatusEntry = { path, index: x, worktree: y, conflicted: x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D') };
    if (x === 'R' || x === 'C') entry.origPath = parts[++i];
    files.push(entry);
  }
  return { branch, upstream, ahead, behind, files };
}

/** Most recent chat in a project (fallback for push approval cards when no turn is running). */
export function latestProjectConversation(db: Database.Database, projectId: string): string | null {
  return listProjectConversations(db, projectId)[0]?.id ?? null;
}
