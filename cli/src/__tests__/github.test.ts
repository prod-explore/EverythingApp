import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, runMigrations, createProject, createConversation } from '../db.js';
import { WebApprovalGate } from '../web-approval.js';
import { KeyVault } from '../providers/key-vault.js';
import { GitHubCredentials, classifyGithubPath } from '../github.js';
import { createGithubRoutes, parseStatus } from '../github-routes.js';
import type { SandboxExec } from '../supervisor-client.js';

const ADMIN = 'admin-secret';
const SECRET = 'x'.repeat(40);

function call(port: number, method: string, path: string, body?: unknown, auth = `Bearer ${ADMIN}`): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', authorization: auth } }, res => {
      const c: Buffer[] = [];
      res.on('data', d => c.push(d));
      res.on('end', () => { const t = Buffer.concat(c).toString(); resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} }); });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; json: unknown }): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const { status = 200, json } = handler(String(url), init ?? {});
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function setup(opts: { fetch?: typeof fetch; exec?: SandboxExec['exec'] } = {}) {
  const db = openDb(':memory:');
  runMigrations(db);
  const project = createProject(db, { name: 'p' });
  const conv = createConversation(db, { projectId: project.id }).id;
  const gate = new WebApprovalGate(db);
  const execs: string[] = [];
  const sandbox: SandboxExec = { exec: opts.exec ?? (async (_o, cmd) => { execs.push(cmd); return { stdout: '', stderr: '', exitCode: 0 }; }) };
  const env = { GIT_PROXY_ADMIN_TOKEN: ADMIN, GIT_PROXY_URL: 'http://git-proxy:8080', GITHUB_PAT: 'github_pat_env' } as NodeJS.ProcessEnv;
  const credentials = new GitHubCredentials(new KeyVault(db, SECRET), env, opts.fetch);
  const routes = createGithubRoutes({ db, approvalGate: gate, credentials, sandbox, activeConversationFor: () => conv, env, fetchImpl: opts.fetch });
  const app = express();
  app.use(express.json());
  app.use('/internal', routes.internal);
  app.use('/api', routes.api);
  const server = app.listen(0);
  await new Promise<void>(r => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { db, project, conv, gate, execs, port, routes, close: () => { server.closeAllConnections(); server.close(); } };
}

describe('classifyGithubPath', () => {
  it('allows repo paths and a few account reads only', () => {
    assert.deepEqual(classifyGithubPath('/repos/o/r/pulls?state=open'), { kind: 'repo', owner: 'o', repo: 'r' });
    assert.deepEqual(classifyGithubPath('/user'), { kind: 'account' });
    assert.equal(classifyGithubPath('/admin/users'), null);
    assert.equal(classifyGithubPath('/repos/o/../x'), null);
    assert.equal(classifyGithubPath('repos/o/r'), null);
  });
});

describe('parseStatus', () => {
  it('parses branch tracking, renames and conflicts', () => {
    const out = ['## main...origin/main [ahead 2, behind 1]', 'M  a.ts', ' M b.ts', 'R  new.ts', 'old.ts', 'UU c.ts', '?? d.ts', ''].join('\0');
    const s = parseStatus(out);
    assert.equal(s.branch, 'main');
    assert.equal(s.upstream, 'origin/main');
    assert.deepEqual([s.ahead, s.behind], [2, 1]);
    assert.deepEqual(s.files.map(f => [f.path, f.index, f.worktree, f.conflicted]), [
      ['a.ts', 'M', ' ', false], ['b.ts', ' ', 'M', false], ['new.ts', 'R', ' ', false], ['c.ts', 'U', 'U', true], ['d.ts', '?', '?', false],
    ]);
    assert.equal(s.files[2]!.origPath, 'old.ts');
  });
});

describe('N4 routes', () => {
  it('internal endpoints require the git-proxy secret; github-token falls back to GITHUB_PAT', async () => {
    const t = await setup();
    try {
      assert.equal((await call(t.port, 'GET', `/internal/github-token?projectId=${t.project.id}`, undefined, 'Bearer nope')).status, 401);
      const r = await call(t.port, 'GET', `/internal/github-token?projectId=${t.project.id}`);
      assert.deepEqual(r.json, { token: 'github_pat_env' });
      assert.equal((await call(t.port, 'GET', '/internal/github-token?projectId=nope')).status, 404);
    } finally { t.close(); }
  });

  it('repo bindings: accepts owner/repo or URL, rejects junk and duplicates', async () => {
    const t = await setup();
    try {
      const a = await call(t.port, 'POST', `/api/projects/${t.project.id}/repos`, { repo: 'https://github.com/acme/site.git' });
      assert.equal(a.status, 201);
      assert.deepEqual(a.json.repos.map((r: any) => [r.owner, r.repo, r.pushMode]), [['acme', 'site', 'ask']]);
      assert.equal((await call(t.port, 'POST', `/api/projects/${t.project.id}/repos`, { owner: 'acme', repo: 'site' })).status, 409);
      assert.equal((await call(t.port, 'POST', `/api/projects/${t.project.id}/repos`, { repo: 'not a repo!' })).status, 400);
      const id = a.json.repos[0].id;
      assert.equal((await call(t.port, 'PATCH', `/api/projects/${t.project.id}/repos/${id}`, { pushMode: 'allow' })).json.repos[0].pushMode, 'allow');
    } finally { t.close(); }
  });

  it('push approval: unlinked repo is refused; a linked push becomes an approval card; force forces once-only', async () => {
    const t = await setup();
    try {
      const refs = [{ ref: 'refs/heads/feat', old: 'a'.repeat(40), new: 'b'.repeat(40), kind: 'update', force: false }];
      const unlinked = await call(t.port, 'POST', '/internal/push-approval', { projectId: t.project.id, owner: 'x', repo: 'y', refs });
      assert.equal(unlinked.json.approved, false);

      await call(t.port, 'POST', `/api/projects/${t.project.id}/repos`, { repo: 'acme/site' });
      const pending = call(t.port, 'POST', '/internal/push-approval', { projectId: t.project.id, owner: 'acme', repo: 'site', refs });
      for (let i = 0; i < 100 && t.gate.listPending().length === 0; i++) await new Promise(r => setTimeout(r, 10));
      const [card] = t.gate.listPending();
      assert.equal(card!.toolLabel, 'git push acme/site:feat');
      assert.equal(card!.conversationId, t.conv);
      assert.equal(card!.dangerous, false);
      t.gate.resolve(card!.id, true, 'once');
      assert.equal((await pending).json.approved, true);

      const forced = call(t.port, 'POST', '/internal/push-approval', { projectId: t.project.id, owner: 'acme', repo: 'site', refs: [{ ...refs[0], force: true }] });
      for (let i = 0; i < 100 && t.gate.listPending().length === 0; i++) await new Promise(r => setTimeout(r, 10));
      const [forceCard] = t.gate.listPending();
      assert.equal(forceCard!.dangerous, true);
      assert.match(forceCard!.warning!, /force/);
      t.gate.resolve(forceCard!.id, false, 'once');
      assert.equal((await forced).json.approved, false);
    } finally { t.close(); }
  });

  it('wires sandbox git through the proxy with a minted token — inside the sandbox, never the GitHub credential', async () => {
    const minted: unknown[] = [];
    const t = await setup({
      fetch: fakeFetch((url, init) => {
        if (url.endsWith('/admin/tokens')) { minted.push(JSON.parse(String(init.body))); return { status: 201, json: { token: 'gpx_abc123', expiresAt: new Date(Date.now() + 3600e3).toISOString() } }; }
        return { status: 404, json: {} };
      }),
    });
    try {
      assert.deepEqual(await t.routes.ensureSandboxGit(t.project.id), { wired: false, repos: 0, reason: 'no repositories linked to this project' });
      await call(t.port, 'POST', `/api/projects/${t.project.id}/repos`, { repo: 'acme/site' });
      assert.deepEqual(await t.routes.ensureSandboxGit(t.project.id), { wired: true, repos: 1 });
      assert.deepEqual((minted[0] as any).repos, [{ owner: 'acme', repo: 'site', pushMode: 'ask' }]);
      const cmd = t.execs.join('\n');
      assert.match(cmd, /x-token:gpx_abc123@git-proxy:8080\/'\.insteadOf https:\/\/github\.com\//);
      assert.match(cmd, /insteadOf git@github\.com:/);
      assert.doesNotMatch(cmd, /github_pat_env/);
      // Cached: no second mint while the token is fresh and the repo set is unchanged.
      await t.routes.ensureSandboxGit(t.project.id);
      assert.equal(minted.length, 1);
    } finally { t.close(); }
  });

  it('source control runs git in the sandbox with quoted arguments and validates paths', async () => {
    const execs: string[] = [];
    const t = await setup({
      exec: async (_o, cmd) => {
        execs.push(cmd);
        return { stdout: cmd.includes('status') ? '## main\0M  a.ts\0' : '', stderr: '', exitCode: 0 };
      },
    });
    try {
      const st = await call(t.port, 'GET', `/api/projects/${t.project.id}/scm/status?dir=site`);
      assert.equal(st.json.branch, 'main');
      assert.match(execs[0]!, /^cd '\/workspace\/site' && git /);
      await call(t.port, 'POST', `/api/projects/${t.project.id}/scm/commit`, { dir: 'site', message: "it's $(rm -rf ~)" });
      assert.match(execs[1]!, /commit -m 'it'\\''s \$\(rm -rf ~\)'/);
      assert.equal((await call(t.port, 'POST', `/api/projects/${t.project.id}/scm/stage`, { dir: 'site', paths: ['../etc/passwd'] })).status, 502);
      assert.equal((await call(t.port, 'GET', `/api/projects/${t.project.id}/scm/status?dir=../x`)).status, 400);
      assert.equal((await call(t.port, 'POST', `/api/projects/${t.project.id}/scm/checkout`, { dir: 'site', branch: '--orphan' })).status, 502);
    } finally { t.close(); }
  });

  it('GitHub API proxy is limited to linked repos', async () => {
    const seen: string[] = [];
    const t = await setup({ fetch: fakeFetch(url => { seen.push(url); return { json: [{ number: 1 }] }; }) });
    try {
      await call(t.port, 'POST', `/api/projects/${t.project.id}/repos`, { repo: 'acme/site' });
      const ok = await call(t.port, 'GET', `/api/projects/${t.project.id}/github/repos/acme/site/pulls?state=open`);
      assert.deepEqual(ok.json, [{ number: 1 }]);
      assert.equal(seen.at(-1), 'https://api.github.com/repos/acme/site/pulls?state=open');
      assert.equal((await call(t.port, 'GET', `/api/projects/${t.project.id}/github/repos/other/repo/pulls`)).status, 403);
      assert.equal((await call(t.port, 'POST', `/api/projects/${t.project.id}/github/user`, {})).status, 405);
    } finally { t.close(); }
  });
});

describe('GitHubCredentials', () => {
  it('device flow: pending → authorized stores an expiring token; refreshes before expiry', async () => {
    const db = openDb(':memory:');
    runMigrations(db);
    let polls = 0;
    let refreshed = 0;
    const creds = new GitHubCredentials(new KeyVault(db, SECRET), { GITHUB_APP_CLIENT_ID: 'Iv1.x' } as NodeJS.ProcessEnv, fakeFetch((url, init) => {
      if (url.endsWith('/login/device/code')) return { json: { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 } };
      if (url.endsWith('/user')) return { json: { login: 'miki' } };
      if (url.endsWith('/login/oauth/access_token')) {
        const body = String(init.body);
        if (body.includes('refresh_token')) { refreshed++; return { json: { access_token: 'ghu_new', expires_in: 28800, refresh_token: 'ghr_2' } }; }
        return ++polls === 1 ? { json: { error: 'authorization_pending' } } : { json: { access_token: 'ghu_old', expires_in: 60, refresh_token: 'ghr_1', refresh_token_expires_in: 15897600 } };
      }
      return { status: 404, json: {} };
    }));
    const start = await creds.startDeviceFlow();
    assert.equal(start.userCode, 'ABCD-1234');
    assert.equal((await creds.pollDeviceFlow()).status, 'pending');
    assert.deepEqual(await creds.pollDeviceFlow(), { status: 'authorized', login: 'miki' });
    assert.deepEqual(await creds.status(), { connected: true, method: 'app', login: 'miki', appConfigured: true, vaultEnabled: true });
    // expires_in 60s < 5 min margin → refresh on use.
    assert.equal(await creds.getToken(), 'ghu_new');
    assert.equal(refreshed, 1);
  });

  it('refuses classic PATs', async () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const creds = new GitHubCredentials(new KeyVault(db, SECRET), {} as NodeJS.ProcessEnv, fakeFetch(() => ({ json: { login: 'x' } })));
    await assert.rejects(creds.setPat('ghp_abcdef123'), /classic/);
    assert.deepEqual(await creds.setPat('github_pat_11ABC_def'), { login: 'x' });
  });
});
