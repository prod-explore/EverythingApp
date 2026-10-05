import type { KeyVault } from './providers/key-vault.js';

/**
 * GitHub credential provider (Plan v3 §7 — "Connect GitHub" like an IDE).
 *
 * Preferred: a GitHub App with the OAuth device flow (user enters a code on github.com; user-to-server
 * tokens expire after ~8h and are refreshed with a ~6 month refresh token). Fallback: a fine-grained PAT
 * limited to chosen repos, or GITHUB_PAT from the environment. Credentials live encrypted in the key vault
 * (row "github") and are only ever handed to server-side code — git-proxy and the GitHub API proxy —
 * never to the sandbox.
 */

interface StoredCredential {
  method: 'app' | 'pat';
  accessToken: string;
  refreshToken?: string;
  /** ISO; absent = does not expire (PAT). */
  expiresAt?: string;
  refreshExpiresAt?: string;
  login?: string;
}

export interface GitHubStatus {
  connected: boolean;
  method: 'app' | 'pat' | 'env' | null;
  login: string | null;
  appConfigured: boolean;
  vaultEnabled: boolean;
  error?: string;
}

export type DevicePollResult =
  | { status: 'pending'; interval: number }
  | { status: 'authorized'; login: string | null }
  | { status: 'denied' | 'expired' | 'error'; error: string };

type FetchLike = typeof fetch;

const VAULT_ROW = 'github';

export class GitHubCredentials {
  private deviceCode: { code: string; interval: number; expiresAt: number } | null = null;
  private refreshing: Promise<string | null> | null = null;

  constructor(
    private readonly vault: KeyVault,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly webBase = env['GITHUB_WEB_URL'] ?? 'https://github.com',
    readonly apiBase = env['GITHUB_API_URL'] ?? 'https://api.github.com',
  ) {}

  private get clientId(): string | undefined {
    return this.env['GITHUB_APP_CLIENT_ID'] || undefined;
  }

  private load(): StoredCredential | null {
    const r = this.vault.read(VAULT_ROW);
    if (r.status !== 'ok') return null;
    try { return JSON.parse(r.key) as StoredCredential; } catch { return null; }
  }

  private save(c: StoredCredential): void {
    this.vault.set(VAULT_ROW, JSON.stringify(c));
  }

  async status(): Promise<GitHubStatus> {
    const base = { appConfigured: !!this.clientId, vaultEnabled: this.vault.enabled };
    const stored = this.load();
    if (stored) return { connected: true, method: stored.method, login: stored.login ?? null, ...base };
    if (this.env['GITHUB_PAT']) return { connected: true, method: 'env', login: null, ...base };
    const raw = this.vault.hasKey(VAULT_ROW);
    return { connected: false, method: null, login: null, ...base, ...(raw.present ? { error: 'stored credential cannot be decrypted — reconnect' } : {}) };
  }

  /** A usable token (refreshing an expiring App token first), or null when not connected. */
  async getToken(): Promise<string | null> {
    const c = this.load();
    if (!c) return this.env['GITHUB_PAT'] || null;
    if (c.method === 'app' && c.expiresAt && Date.parse(c.expiresAt) - Date.now() < 5 * 60_000) {
      this.refreshing ??= this.refresh(c).finally(() => { this.refreshing = null; });
      return this.refreshing;
    }
    return c.accessToken;
  }

  private async refresh(c: StoredCredential): Promise<string | null> {
    if (!c.refreshToken || !this.clientId) return null;
    const body = new URLSearchParams({ client_id: this.clientId, grant_type: 'refresh_token', refresh_token: c.refreshToken });
    if (this.env['GITHUB_APP_CLIENT_SECRET']) body.set('client_secret', this.env['GITHUB_APP_CLIENT_SECRET']);
    const res = await this.fetchImpl(`${this.webBase}/login/oauth/access_token`, { method: 'POST', headers: { Accept: 'application/json' }, body });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof json['access_token'] !== 'string') return null;
    this.save(this.fromTokenResponse(json, c.login));
    return json['access_token'];
  }

  private fromTokenResponse(json: Record<string, unknown>, login?: string): StoredCredential {
    const now = Date.now();
    const exp = (k: string) => (typeof json[k] === 'number' ? new Date(now + (json[k] as number) * 1000).toISOString() : undefined);
    return {
      method: 'app',
      accessToken: json['access_token'] as string,
      refreshToken: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : undefined,
      expiresAt: exp('expires_in'),
      refreshExpiresAt: exp('refresh_token_expires_in'),
      login,
    };
  }

  async startDeviceFlow(): Promise<{ userCode: string; verificationUri: string; expiresIn: number; interval: number }> {
    if (!this.clientId) throw new Error('GITHUB_APP_CLIENT_ID is not configured — use a fine-grained token instead, or set up a GitHub App');
    if (!this.vault.enabled) throw new Error(this.vault.disabledReason ?? 'key vault disabled');
    const res = await this.fetchImpl(`${this.webBase}/login/device/code`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.clientId }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof json['device_code'] !== 'string') throw new Error(`GitHub refused the device flow: ${String(json['error_description'] ?? json['error'] ?? res.status)}`);
    const interval = Number(json['interval'] ?? 5);
    const expiresIn = Number(json['expires_in'] ?? 900);
    this.deviceCode = { code: json['device_code'], interval, expiresAt: Date.now() + expiresIn * 1000 };
    return { userCode: String(json['user_code']), verificationUri: String(json['verification_uri']), expiresIn, interval };
  }

  async pollDeviceFlow(): Promise<DevicePollResult> {
    const dc = this.deviceCode;
    if (!dc || !this.clientId) return { status: 'error', error: 'no device flow in progress' };
    if (Date.now() > dc.expiresAt) { this.deviceCode = null; return { status: 'expired', error: 'the code expired — start again' }; }
    const res = await this.fetchImpl(`${this.webBase}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.clientId, device_code: dc.code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof json['access_token'] === 'string') {
      this.deviceCode = null;
      const login = await this.fetchLogin(json['access_token']);
      this.save(this.fromTokenResponse(json, login ?? undefined));
      return { status: 'authorized', login };
    }
    switch (json['error']) {
      case 'authorization_pending': return { status: 'pending', interval: dc.interval };
      case 'slow_down': dc.interval = Number(json['interval'] ?? dc.interval + 5); return { status: 'pending', interval: dc.interval };
      case 'access_denied': this.deviceCode = null; return { status: 'denied', error: 'authorization was denied on GitHub' };
      case 'expired_token': this.deviceCode = null; return { status: 'expired', error: 'the code expired — start again' };
      default: return { status: 'error', error: String(json['error_description'] ?? json['error'] ?? `HTTP ${res.status}`) };
    }
  }

  async setPat(token: string): Promise<{ login: string | null }> {
    const t = token.trim();
    if (!/^(github_pat_|ghp_|gho_|ghu_|ghs_)[A-Za-z0-9_]+$/.test(t)) throw new Error('that does not look like a GitHub token');
    if (t.startsWith('ghp_')) {
      // Classic PATs grant `repo` on everything — Plan v3 §7 says no. Fine-grained only.
      throw new Error('classic tokens (ghp_…) are not accepted — create a fine-grained token limited to the repos you need');
    }
    const login = await this.fetchLogin(t);
    if (login === null) throw new Error('GitHub rejected the token');
    this.save({ method: 'pat', accessToken: t, login });
    return { login };
  }

  disconnect(): void {
    this.vault.delete(VAULT_ROW);
    this.deviceCode = null;
  }

  private async fetchLogin(token: string): Promise<string | null> {
    try {
      const res = await this.fetchImpl(`${this.apiBase}/user`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'EverythingApp' } });
      if (!res.ok) return null;
      return ((await res.json()) as { login?: string }).login ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * Which GitHub REST paths the human-facing panel may reach through the server: anything under a repo bound
 * to the project, plus a few account-level reads. Returns the owner/repo it targets, 'account', or null.
 */
export function classifyGithubPath(path: string): { kind: 'repo'; owner: string; repo: string } | { kind: 'account' } | null {
  if (!path.startsWith('/') || path.includes('..') || /[\s#]/.test(path)) return null;
  const clean = path.split('?')[0]!;
  const m = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/.*)?$/.exec(clean);
  if (m) return { kind: 'repo', owner: m[1]!, repo: m[2]! };
  if (/^\/(user|user\/repos|user\/installations|search\/(issues|code|repositories|commits)|notifications|rate_limit)$/.test(clean)) return { kind: 'account' };
  return null;
}
