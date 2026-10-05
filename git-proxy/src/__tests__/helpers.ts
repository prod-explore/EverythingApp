import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuditLog } from '../audit.js';
import { HttpOrchestrator, OrchestratorCredentialProvider } from '../orchestrator.js';
import { encodePkt, FLUSH_PKT } from '../pktline.js';
import type { CompareFn } from '../push.js';
import { createGitProxy, type ProxyConfig } from '../server.js';
import { TokenStore, type RepoGrant } from '../tokens.js';

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface Listening {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}

export function listen(handler: Handler | http.Server): Promise<Listening> {
  const server = handler instanceof http.Server ? handler : http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({
        server,
        url,
        close: () =>
          new Promise<void>(r => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export const sha = (c: string) => c.repeat(40).slice(0, 40);
export const ZERO = '0'.repeat(40);

export function receivePackBody(cmds: { old: string; new: string; ref: string }[], caps = 'report-status side-band-64k agent=git/2.45', pack = Buffer.alloc(0)): Buffer {
  return Buffer.concat([
    ...cmds.map((c, i) => encodePkt(`${c.old} ${c.new} ${c.ref}${i === 0 ? `\0${caps}` : ''}\n`)),
    FLUSH_PKT,
    pack,
  ]);
}

export interface HarnessOptions {
  upstream?: Handler;
  /** Overrides for orchestrator endpoints; default approves nothing (404) and serves token ghs_project. */
  pushApproval?: (body: any, req: IncomingMessage, res: ServerResponse) => void;
  githubToken?: (projectId: string, res: ServerResponse) => void;
  compare?: CompareFn;
  now?: () => number;
  fallbackPat?: string;
  approvalTimeoutMs?: number;
}

export interface Harness {
  proxy: string;
  tokens: TokenStore;
  upstreamSeen: SeenRequest[];
  approvals: any[];
  auditPosts: any[];
  auditLines: string[];
  mint: (repos: Partial<RepoGrant>[] | RepoGrant[], ttl?: number) => string;
  close: () => Promise<void>;
}

export const ADMIN = 'admin-secret';

export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const upstreamSeen: SeenRequest[] = [];
  const approvals: any[] = [];
  const auditPosts: any[] = [];
  const auditLines: string[] = [];

  const upstream = await listen(async (req, res) => {
    if (opts.upstream) {
      // Handler reads the body itself (streaming tests); we record headers only.
      upstreamSeen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.alloc(0) });
      opts.upstream(req, res);
      return;
    }
    const body = await readBody(req);
    upstreamSeen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'application/x-git-result' });
    res.end('upstream-ok');
  });

  const orch = await listen(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${ADMIN}`) {
      res.writeHead(401).end();
      return;
    }
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/internal/github-token') {
      if (opts.githubToken) return opts.githubToken(u.searchParams.get('projectId')!, res);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: `ghs_${u.searchParams.get('projectId')}` }));
      return;
    }
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    if (u.pathname === '/internal/audit') {
      auditPosts.push(body);
      res.writeHead(204).end();
      return;
    }
    if (u.pathname === '/internal/push-approval') {
      approvals.push(body);
      if (opts.pushApproval) return opts.pushApproval(body, req, res);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ approved: false }));
      return;
    }
    res.writeHead(404).end();
  });

  const tokens = new TokenStore(opts.now);
  const orchestrator = new HttpOrchestrator(orch.url, ADMIN);
  const cfg: ProxyConfig = {
    adminToken: ADMIN,
    tokens,
    credentials: new OrchestratorCredentialProvider({ orchestratorUrl: orch.url, adminToken: ADMIN, fallbackPat: opts.fallbackPat, cacheMs: 0 }),
    orchestrator,
    audit: new AuditLog(e => orchestrator.postAudit(e), line => auditLines.push(line)),
    compare: opts.compare ?? (async () => null),
    upstreamUrl: upstream.url,
    protectedBranches: ['main', 'master'],
    approvalTimeoutMs: opts.approvalTimeoutMs ?? 5_000,
    defaultTtlSeconds: 3600,
    maxTtlSeconds: 86400,
  };
  const proxy = await listen(createGitProxy(cfg));

  return {
    proxy: proxy.url,
    tokens,
    upstreamSeen,
    approvals,
    auditPosts,
    auditLines,
    mint: (repos, ttl = 600) =>
      tokens.mint(
        'proj1',
        repos.map(r => ({ owner: r.owner ?? 'acme', repo: r.repo ?? 'app', pushMode: r.pushMode ?? 'ask' })),
        ttl,
      ).token,
    close: async () => {
      await proxy.close();
      await upstream.close();
      await orch.close();
    },
  };
}

export const basic = (token: string, user = 'x-token') => `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;

/** Decodes a pkt-line stream into payloads (null = flush). */
export function decodePkts(buf: Buffer): (Buffer | null)[] {
  const out: (Buffer | null)[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.toString('latin1', off, off + 4), 16);
    if (len === 0) {
      out.push(null);
      off += 4;
      continue;
    }
    out.push(buf.subarray(off + 4, off + len));
    off += len;
  }
  return out;
}
