import { AuditLog } from './audit.js';
import { HttpOrchestrator, OrchestratorCredentialProvider } from './orchestrator.js';
import { githubCompare } from './push.js';
import { createGitProxy } from './server.js';
import { TokenStore } from './tokens.js';

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
};
const int = (name: string, fallback: number) => parseInt(env(name) ?? String(fallback), 10);

function main(): void {
  const adminToken = env('GIT_PROXY_ADMIN_TOKEN');
  if (!adminToken) throw new Error('GIT_PROXY_ADMIN_TOKEN is required');
  const orchestratorUrl = env('ORCHESTRATOR_URL');
  const fallbackPat = env('GITHUB_PAT');
  if (!orchestratorUrl && !fallbackPat) console.warn('[git-proxy] neither ORCHESTRATOR_URL nor GITHUB_PAT set: every request will fail with 503');
  if (!orchestratorUrl) console.warn('[git-proxy] ORCHESTRATOR_URL not set: pushes that need approval will be rejected');

  const tokens = new TokenStore();
  const orchestrator = new HttpOrchestrator(orchestratorUrl, adminToken);
  const credentials = new OrchestratorCredentialProvider({ orchestratorUrl, adminToken, fallbackPat });
  const server = createGitProxy({
    adminToken,
    tokens,
    credentials,
    orchestrator,
    audit: new AuditLog(e => orchestrator.postAudit(e)),
    compare: githubCompare(env('GITHUB_API_URL') ?? 'https://api.github.com', credentials),
    upstreamUrl: env('GITHUB_UPSTREAM_URL') ?? 'https://github.com',
    protectedBranches: (env('GIT_PROXY_PROTECTED_BRANCHES') ?? 'main,master').split(',').map(s => s.trim()).filter(Boolean),
    approvalTimeoutMs: int('PUSH_APPROVAL_TIMEOUT_MS', 10 * 60_000),
    defaultTtlSeconds: int('GIT_PROXY_DEFAULT_TOKEN_TTL_SECONDS', 3600),
    maxTtlSeconds: int('GIT_PROXY_MAX_TOKEN_TTL_SECONDS', 24 * 3600),
  });
  // Long-polled push approvals and big packs: no server-side request timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  const port = int('GIT_PROXY_PORT', 8080);
  server.listen(port, '0.0.0.0', () => console.log(`[git-proxy] listening on port ${port}`));
  setInterval(() => tokens.sweep(), 60_000).unref();

  const stop = () => {
    server.close();
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

try {
  main();
} catch (err) {
  console.error('[git-proxy] fatal startup error:', err);
  process.exit(1);
}
