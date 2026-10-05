// git smart-HTTP pass-through to GitHub with credential injection, repo binding and push approval.
import http, { type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { buildRejection, readCommandSection, PktLineError } from './pktline.js';
import { classifyRefs, decidePush, type ClassifiedRef, type CompareFn } from './push.js';
import { CredentialError, type CredentialProvider, type Orchestrator } from './orchestrator.js';
import { findGrant, PUSH_MODES, TokenStore, type RepoGrant, type TokenBinding } from './tokens.js';
import type { AuditLog } from './audit.js';

export interface ProxyConfig {
  adminToken: string;
  tokens: TokenStore;
  credentials: CredentialProvider;
  orchestrator: Orchestrator;
  audit: AuditLog;
  compare: CompareFn;
  /** Normally https://github.com */
  upstreamUrl: string;
  protectedBranches: string[];
  approvalTimeoutMs: number;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
}

const GIT_ROUTE = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/[A-Za-z0-9_/.-]+)$/;
const NAME_OK = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

// Request headers we pass upstream. Authorization/Cookie/Proxy-* from the sandbox are never forwarded.
const FORWARD_REQ_HEADERS = ['content-type', 'accept', 'accept-encoding', 'content-encoding', 'content-length', 'git-protocol', 'user-agent', 'pragma'];
const DROP_RES_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'www-authenticate', 'set-cookie', 'proxy-authenticate']);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: OutgoingHttpHeaders = {},
  ) {
    super(message);
  }
}

function sendText(res: ServerResponse, status: number, message: string, headers: OutgoingHttpHeaders = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // git prints text/plain error bodies to the user as "remote: …".
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', ...headers });
  res.end(message.endsWith('\n') ? message : message + '\n');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function extractProxyToken(header: string | undefined): string | null {
  if (!header) return null;
  const sp = header.indexOf(' ');
  if (sp < 0) return null;
  const scheme = header.slice(0, sp).toLowerCase();
  const value = header.slice(sp + 1).trim();
  if (scheme === 'bearer') return value || null;
  if (scheme === 'basic') {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    const user = colon < 0 ? decoded : decoded.slice(0, colon);
    const pass = colon < 0 ? '' : decoded.slice(colon + 1);
    return pass || user || null;
  }
  return null;
}

const sha = (s: string) => createHash('sha256').update(s).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function drain(stream: Readable): Promise<void> {
  return new Promise(resolve => {
    if (stream.readableEnded || stream.destroyed) return resolve();
    stream.on('end', resolve);
    stream.on('error', () => resolve());
    stream.on('close', () => resolve());
    stream.resume();
  });
}

interface GitCtx {
  binding: TokenBinding;
  grant: RepoGrant;
  owner: string;
  repo: string;
  endpoint: string;
}

export function createGitProxy(cfg: ProxyConfig): http.Server {
  const upstream = new URL(cfg.upstreamUrl);
  const upstreamOrigin = upstream.origin;
  const upstreamPrefix = upstream.pathname.replace(/\/+$/, '');
  const transport = upstream.protocol === 'https:' ? https : http;

  // ---------- admin API ----------
  async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const auth = req.headers.authorization ?? '';
    const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!presented || !safeEqual(presented, cfg.adminToken)) throw new HttpError(401, 'unauthorized');

    if (req.method === 'POST' && url.pathname === '/admin/tokens') {
      const body = (await readJson(req)) as { projectId?: unknown; repos?: unknown; ttlSeconds?: unknown };
      if (typeof body.projectId !== 'string' || !body.projectId) throw new HttpError(400, 'projectId (string) is required');
      if (!Array.isArray(body.repos) || body.repos.length === 0) throw new HttpError(400, 'repos must be a non-empty array');
      const repos: RepoGrant[] = body.repos.map((r: unknown, i: number) => {
        const g = (r ?? {}) as { owner?: unknown; repo?: unknown; pushMode?: unknown };
        if (typeof g.owner !== 'string' || !NAME_OK.test(g.owner)) throw new HttpError(400, `repos[${i}].owner is invalid`);
        if (typeof g.repo !== 'string' || !NAME_OK.test(g.repo)) throw new HttpError(400, `repos[${i}].repo is invalid`);
        const pushMode = g.pushMode ?? 'ask';
        if (!PUSH_MODES.includes(pushMode as RepoGrant['pushMode'])) throw new HttpError(400, `repos[${i}].pushMode must be allow|ask|deny`);
        return { owner: g.owner, repo: g.repo, pushMode: pushMode as RepoGrant['pushMode'] };
      });
      let ttl = body.ttlSeconds === undefined ? cfg.defaultTtlSeconds : Number(body.ttlSeconds);
      if (!Number.isFinite(ttl) || ttl <= 0) throw new HttpError(400, 'ttlSeconds must be a positive number');
      ttl = Math.min(ttl, cfg.maxTtlSeconds);
      const minted = cfg.tokens.mint(body.projectId, repos, ttl);
      cfg.audit.emit({
        type: 'token_minted',
        projectId: body.projectId,
        repos: repos.map(r => `${r.owner}/${r.repo}:${r.pushMode}`),
        expiresAt: minted.expiresAt,
      });
      sendJson(res, 201, minted);
      return;
    }
    if (req.method === 'DELETE' && url.pathname === '/admin/tokens') {
      const projectId = url.searchParams.get('projectId');
      if (!projectId) throw new HttpError(400, 'projectId query parameter is required');
      const revoked = cfg.tokens.revokeProject(projectId);
      cfg.audit.emit({ type: 'tokens_revoked', projectId, count: revoked });
      sendJson(res, 200, { revoked });
      return;
    }
    const m = /^\/admin\/tokens\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'DELETE' && m) {
      const ok = cfg.tokens.revoke(decodeURIComponent(m[1]!));
      cfg.audit.emit({ type: 'token_revoked', found: ok });
      if (!ok) throw new HttpError(404, 'token not found');
      res.writeHead(204).end();
      return;
    }
    throw new HttpError(404, 'not found');
  }

  // ---------- upstream forwarding ----------
  function forward(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: GitCtx,
    githubToken: string,
    opts: { head?: Buffer; body?: Readable; decompressed?: boolean } = {},
  ): Promise<void> {
    return new Promise(resolve => {
      const target = new URL(`${upstreamPrefix}/${ctx.owner}/${ctx.repo}.git/${ctx.endpoint}`, upstreamOrigin);
      const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      target.search = query;

      const headers: OutgoingHttpHeaders = {};
      for (const h of FORWARD_REQ_HEADERS) {
        const v = req.headers[h];
        if (v !== undefined) headers[h] = v;
      }
      if (opts.decompressed) {
        delete headers['content-encoding'];
        delete headers['content-length'];
      }
      headers['authorization'] = `Basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`;

      const upReq = transport.request(target, { method: req.method, headers }, upRes => {
        const status = upRes.statusCode ?? 502;
        if (status === 401) {
          upRes.resume();
          sendText(res, 502, 'git-proxy: GitHub rejected the credentials configured for this project.');
          return resolve();
        }
        const out: OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v === undefined || DROP_RES_HEADERS.has(k)) continue;
          if (k === 'location' && typeof v === 'string' && v.startsWith(upstreamOrigin)) {
            out[k] = v.slice(upstreamOrigin.length + upstreamPrefix.length) || '/';
            continue;
          }
          out[k] = v;
        }
        res.writeHead(status, out);
        upRes.pipe(res);
        upRes.on('end', () => resolve());
        upRes.on('error', () => {
          res.destroy();
          resolve();
        });
      });
      upReq.on('error', () => {
        sendText(res, 502, 'git-proxy: cannot reach GitHub.');
        resolve();
      });
      res.on('close', () => {
        if (!res.writableFinished) upReq.destroy();
        resolve();
      });

      if (req.method === 'GET' || req.method === 'HEAD') {
        upReq.end();
        return;
      }
      if (opts.head) upReq.write(opts.head);
      const body = opts.body ?? req;
      body.on('error', () => upReq.destroy());
      body.pipe(upReq);
    });
  }

  async function rejectPush(
    res: ServerResponse,
    body: Readable,
    refs: string[],
    capabilities: string[],
    reason: string,
  ): Promise<void> {
    await drain(body);
    const message = `git-proxy: push rejected (${reason}).`;
    const payload = buildRejection(refs, reason, capabilities, message);
    if (!payload) {
      sendText(res, 403, message);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
    res.end(payload);
  }

  async function handleReceivePack(req: IncomingMessage, res: ServerResponse, ctx: GitCtx, auditBase: Record<string, unknown>): Promise<void> {
    const gzip = /gzip/i.test(String(req.headers['content-encoding'] ?? ''));
    const body: Readable = gzip ? req.pipe(createGunzip()) : req;
    if (gzip) req.on('error', err => body.destroy(err));

    let head: Buffer;
    let section;
    try {
      ({ head, section } = await readCommandSection(body));
    } catch (err) {
      if (err instanceof PktLineError) throw new HttpError(400, `git-proxy: ${err.message}`);
      throw new HttpError(400, 'git-proxy: unreadable receive-pack request');
    }

    const githubToken = await cfg.credentials.getGithubToken(ctx.binding.projectId);

    // A bare flush-pkt is git's auth probe before a large push — nothing to approve.
    if (section.commands.length === 0) {
      await forward(req, res, ctx, githubToken, { head, body, decompressed: gzip });
      return;
    }

    const refs: ClassifiedRef[] = await classifyRefs(section.commands, (b, h) =>
      cfg.compare(ctx.binding.projectId, ctx.owner, ctx.repo, b, h),
    );
    const decision = decidePush(ctx.grant.pushMode, refs, cfg.protectedBranches);
    let approved = decision.action === 'allow';
    let reason = decision.reason;

    if (decision.action === 'ask') {
      const ac = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) ac.abort();
      };
      res.on('close', onClose);
      const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(cfg.approvalTimeoutMs)]);
      const result = await cfg.orchestrator.requestPushApproval(
        { projectId: ctx.binding.projectId, owner: ctx.owner, repo: ctx.repo, refs },
        signal,
      );
      res.off('close', onClose);
      approved = result.approved;
      reason = result.reason ?? (approved ? 'approved by user' : 'rejected by user');
    }

    cfg.audit.emit({
      ...auditBase,
      type: 'push_decision',
      refs,
      policy: decision.action,
      approved,
      reason,
    });

    if (!approved) {
      const ngReason = decision.action === 'deny' ? 'push disabled for this repository' : reason === 'rejected by user' ? reason : `rejected: ${reason}`;
      await rejectPush(res, body, refs.map(r => r.ref), section.capabilities, ngReason);
      return;
    }
    await forward(req, res, ctx, githubToken, { head, body, decompressed: gzip });
  }

  async function handleLfs(req: IncomingMessage, res: ServerResponse, ctx: GitCtx, githubToken: string): Promise<void> {
    if (ctx.grant.pushMode !== 'deny' || req.method === 'GET') {
      await forward(req, res, ctx, githubToken);
      return;
    }
    // pushMode deny: only batch *downloads* may pass.
    if (ctx.endpoint !== 'info/lfs/objects/batch') throw new HttpError(403, 'git-proxy: LFS writes are disabled for this repository.');
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let n = 0;
      req.on('data', (c: Buffer) => {
        n += c.length;
        if (n > 4 * 1024 * 1024) {
          reject(new HttpError(413, 'LFS batch request too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
    let op: unknown;
    try {
      op = (JSON.parse(raw.toString('utf8')) as { operation?: unknown }).operation;
    } catch {
      throw new HttpError(400, 'invalid LFS batch request');
    }
    if (op !== 'download') throw new HttpError(403, 'git-proxy: LFS uploads are disabled for this repository.');
    await forward(req, res, ctx, githubToken, { body: Readable.from([raw]) });
  }

  async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, m: RegExpExecArray, audit: Record<string, unknown>): Promise<void> {
    const [, owner, repo, endpoint] = m as unknown as [string, string, string, string];
    if (!NAME_OK.test(owner) || !NAME_OK.test(repo)) throw new HttpError(404, 'git-proxy: not found');
    Object.assign(audit, { owner, repo, endpoint });

    const token = extractProxyToken(req.headers.authorization);
    if (!token) {
      throw new HttpError(401, 'git-proxy: authentication required', { 'www-authenticate': 'Basic realm="EverythingApp git-proxy"' });
    }
    const binding = cfg.tokens.verify(token);
    if (!binding) {
      throw new HttpError(401, 'git-proxy: proxy token is invalid or expired; ask EverythingApp for a new one.', {
        'www-authenticate': 'Basic realm="EverythingApp git-proxy"',
      });
    }
    audit['projectId'] = binding.projectId;
    const grant = findGrant(binding, owner, repo);
    if (!grant) {
      throw new HttpError(403, `git-proxy: repository ${owner}/${repo} is not linked to this project. Link it in EverythingApp to use it here.`);
    }
    const ctx: GitCtx = { binding, grant, owner, repo, endpoint };

    if (endpoint === 'info/refs') {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        throw new HttpError(403, 'git-proxy: only smart HTTP (service=git-upload-pack|git-receive-pack) is supported.');
      }
      audit['service'] = service;
      if (service === 'git-receive-pack' && grant.pushMode === 'deny') {
        throw new HttpError(403, `git-proxy: pushing to ${owner}/${repo} is disabled for this project.`);
      }
      await forward(req, res, ctx, await cfg.credentials.getGithubToken(binding.projectId));
      return;
    }
    if (endpoint === 'git-upload-pack') {
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      await forward(req, res, ctx, await cfg.credentials.getGithubToken(binding.projectId));
      return;
    }
    if (endpoint === 'git-receive-pack') {
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      // pushMode deny is enforced inside (after parsing) so the client gets a per-ref "ng" report.
      await handleReceivePack(req, res, ctx, audit);
      return;
    }
    // LFS (best effort)
    if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    await handleLfs(req, res, ctx, await cfg.credentials.getGithubToken(binding.projectId));
  }

  return http.createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://git-proxy.local');
    const audit: Record<string, unknown> = { method: req.method, path: url.pathname };

    if (url.pathname === '/health') {
      sendJson(res, 200, { ok: true, tokens: cfg.tokens.size });
      return;
    }

    const isAdmin = url.pathname === '/admin' || url.pathname.startsWith('/admin/');
    const gitMatch = isAdmin ? null : GIT_ROUTE.exec(url.pathname);
    if (!isAdmin) {
      res.on('close', () => {
        cfg.audit.emit({ type: 'request', ...audit, status: res.statusCode, completed: res.writableFinished, durationMs: Date.now() - started });
      });
    }

    const run = isAdmin
      ? handleAdmin(req, res, url)
      : gitMatch
        ? handleGit(req, res, url, gitMatch, audit)
        : Promise.reject(new HttpError(404, 'git-proxy: not a git smart-HTTP endpoint'));

    run.catch(err => {
      req.resume();
      if (err instanceof HttpError) {
        if (isAdmin) {
          if (!res.headersSent) sendJson(res, err.status, { error: err.message });
        } else sendText(res, err.status, err.message, err.headers);
        return;
      }
      if (err instanceof CredentialError) {
        sendText(res, 503, `git-proxy: ${err.message}`);
        return;
      }
      audit['error'] = String((err as Error)?.message ?? err);
      sendText(res, 500, 'git-proxy: internal error');
    });
  });
}
