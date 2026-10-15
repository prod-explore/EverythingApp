import type Database from 'better-sqlite3';
import type { KeyVault } from './providers/key-vault.js';
import { getSetting, setSetting } from './db.js';

/**
 * "Something is waiting for you" as a plain HTTP POST — deterministic, no model involved. Works with ntfy (self-hosted or
 * ntfy.sh, which pushes to the phone), Discord and Slack webhooks, Home Assistant, or anything that takes JSON.
 *
 * - The URL is a secret (ntfy topics, Discord/Slack tokens): it lives in the key vault, never in the settings table.
 * - Events: an approval waiting, a question waiting (request_human_input), an urgent report. Approvals and questions are
 *   sent only if they are still waiting after a short delay, so working in the open tab does not buzz the phone.
 * - Text is minimal by default ("An action is waiting for your approval."). Details (chat title, tool) are opt-in.
 *   A ghost chat never contributes anything but a content-free line.
 */

export const NOTIFY_VAULT_KEY = 'notify:webhook';
const SETTING_KEY = 'notify_config';

export type NotifyFormat = 'auto' | 'text' | 'json' | 'discord' | 'slack';
export type NotifyKind = 'approval' | 'question' | 'urgent';

export interface NotifyConfig {
  format: NotifyFormat;
  /** Where the app is reachable from the phone; sent as the click-through link when set. */
  appUrl: string;
  events: Record<NotifyKind, boolean>;
  /** Include the chat title and tool/question title. Off by default. */
  details: boolean;
  /** How long an approval or question must have been waiting before it is sent. */
  delaySeconds: number;
}

const DEFAULTS: NotifyConfig = {
  format: 'auto',
  appUrl: '',
  events: { approval: true, question: true, urgent: true },
  details: false,
  delaySeconds: 30,
};

const FORMATS: readonly NotifyFormat[] = ['auto', 'text', 'json', 'discord', 'slack'];

export class NotifyConfigError extends Error {}

export function normalizeWebhookUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new NotifyConfigError('That is not a valid URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new NotifyConfigError('The webhook URL must start with http:// or https://.');
  return u.toString();
}

export function loadNotifyConfig(db: Database.Database): NotifyConfig {
  let raw: Partial<NotifyConfig> & { events?: Partial<Record<NotifyKind, unknown>> } = {};
  try { raw = JSON.parse(getSetting(db, SETTING_KEY) ?? '{}') as typeof raw; } catch { /* use defaults */ }
  const ev: Partial<Record<NotifyKind, unknown>> = raw.events ?? {};
  return {
    format: FORMATS.includes(raw.format as NotifyFormat) ? (raw.format as NotifyFormat) : DEFAULTS.format,
    appUrl: typeof raw.appUrl === 'string' ? raw.appUrl : DEFAULTS.appUrl,
    events: {
      approval: ev.approval !== false,
      question: ev.question !== false,
      urgent: ev.urgent !== false,
    },
    details: raw.details === true,
    delaySeconds: typeof raw.delaySeconds === 'number' && raw.delaySeconds >= 0 ? Math.min(raw.delaySeconds, 3600) : DEFAULTS.delaySeconds,
  };
}

export function saveNotifyConfig(db: Database.Database, patch: Partial<NotifyConfig>): NotifyConfig {
  const cur = loadNotifyConfig(db);
  const next: NotifyConfig = { ...cur, ...patch, events: { ...cur.events, ...(patch.events ?? {}) } };
  if (!FORMATS.includes(next.format)) throw new NotifyConfigError('Unknown format.');
  if (next.appUrl.trim()) next.appUrl = normalizeWebhookUrl(next.appUrl).replace(/\/$/, '');
  else next.appUrl = '';
  if (!(typeof next.delaySeconds === 'number' && next.delaySeconds >= 0 && next.delaySeconds <= 3600)) throw new NotifyConfigError('The delay must be between 0 and 3600 seconds.');
  setSetting(db, SETTING_KEY, JSON.stringify(next));
  return next;
}

export interface NotifyPayload {
  title: string;
  message: string;
  /** ntfy priority 1-5 (3 default). */
  priority: number;
  link?: string;
}

/** The format `auto` resolves to for a URL. */
export function detectFormat(url: string): Exclude<NotifyFormat, 'auto'> {
  const u = new URL(url);
  if (/(^|\.)discord(app)?\.com$/.test(u.hostname) && u.pathname.includes('/webhooks/')) return 'discord';
  if (u.hostname === 'hooks.slack.com') return 'slack';
  return 'text';
}

/** The request for one payload: ntfy-style plain text, or JSON in the shape the target wants. */
export function buildRequest(url: string, format: NotifyFormat, p: NotifyPayload): { headers: Record<string, string>; body: string } {
  const f = format === 'auto' ? detectFormat(url) : format;
  const line = p.link ? `${p.message}\n${p.link}` : p.message;
  switch (f) {
    case 'discord': return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${p.title}**\n${line}`.slice(0, 1900), allowed_mentions: { parse: [] } }) };
    case 'slack': return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `*${p.title}*\n${line}` }) };
    case 'json': return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: p.title, message: p.message, priority: p.priority, ...(p.link ? { link: p.link } : {}) }) };
    default: {
      // ntfy: the body is the message, the rest are headers (header values must be latin1-safe).
      const safe = (s: string) => s.replace(/[^\x20-\x7e]/g, '?');
      return {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: safe(p.title), Priority: String(p.priority), ...(p.link ? { Click: p.link } : {}) },
        body: p.message,
      };
    }
  }
}

export interface NotifyEvent {
  kind: NotifyKind;
  /** A ghost chat contributes nothing but a content-free line, whatever the details setting says. */
  ghost: boolean;
  chatTitle?: string;
  /** Tool label, or the question/report title. */
  detail?: string;
  /** Re-checked after the delay; false = the user already dealt with it. */
  stillWaiting?: () => boolean;
  conversationId?: string;
}

const MESSAGES: Record<NotifyKind, { title: string; minimal: string }> = {
  approval: { title: 'Approval needed', minimal: 'An action is waiting for your approval.' },
  question: { title: 'A question is waiting', minimal: 'The assistant is waiting for your answer.' },
  urgent: { title: 'Urgent', minimal: 'There is an urgent item in Gazeta.' },
};

export function buildPayload(cfg: NotifyConfig, ev: NotifyEvent): NotifyPayload {
  const m = MESSAGES[ev.kind];
  let message = m.minimal;
  if (ev.ghost) message = 'Something is waiting in a private chat.';
  else if (cfg.details) {
    const parts = [ev.chatTitle, ev.detail].map(s => (s ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (parts.length) message = `${m.minimal} ${parts.join(' — ')}`.slice(0, 300);
  }
  return {
    title: m.title,
    message,
    priority: ev.kind === 'urgent' ? 5 : 4,
    ...(cfg.appUrl ? { link: cfg.appUrl } : {}),
  };
}

export interface NotifierDeps {
  db: Database.Database;
  vault: KeyVault;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Test seam for the delay timer. */
  setTimer?: (fn: () => void, ms: number) => void;
}

export class Notifier {
  /** Last send per kind+detail, so a loop cannot flood the phone. */
  private readonly recent = new Map<string, number>();
  lastError: string | null = null;

  constructor(private readonly deps: NotifierDeps) {}

  /** The configured URL: the vault, else NOTIFY_WEBHOOK_URL. Null = notifications are off. */
  url(): string | null {
    const stored = this.deps.vault.read(NOTIFY_VAULT_KEY);
    if (stored.status === 'ok') return stored.key;
    const fromEnv = ((this.deps.env ?? process.env)['NOTIFY_WEBHOOK_URL'] ?? '').trim();
    return fromEnv || null;
  }

  describe() {
    const key = this.deps.vault.hasKey(NOTIFY_VAULT_KEY);
    const envUrl = !key.present && !!((this.deps.env ?? process.env)['NOTIFY_WEBHOOK_URL'] ?? '').trim();
    return {
      ...loadNotifyConfig(this.deps.db),
      webhook: { present: key.present || envUrl, fromEnv: envUrl, host: this.hostOf() },
      vaultEnabled: this.deps.vault.enabled,
      vaultDisabledReason: this.deps.vault.disabledReason,
      lastError: this.lastError,
    };
  }

  /** Only the host, so the settings page can show where it goes without exposing the token in the path. */
  private hostOf(): string | null {
    const u = this.url();
    try { return u ? new URL(u).host : null; } catch { return null; }
  }

  /** Queue an event. Never throws and never blocks the caller. */
  notify(ev: NotifyEvent): void {
    try {
      const cfg = loadNotifyConfig(this.deps.db);
      if (!cfg.events[ev.kind] || !this.url()) return;
      const delayMs = ev.kind === 'urgent' ? 0 : cfg.delaySeconds * 1000;
      const fire = () => {
        if (ev.stillWaiting && !ev.stillWaiting()) return;
        const key = `${ev.kind}:${ev.conversationId ?? ''}:${ev.detail ?? ''}`;
        const now = Date.now();
        if (now - (this.recent.get(key) ?? 0) < 10_000) return;
        this.recent.set(key, now);
        if (this.recent.size > 200) for (const [k, t] of this.recent) if (now - t > 60_000) this.recent.delete(k);
        void this.send(buildPayload(cfg, ev)).catch(() => undefined);
      };
      if (delayMs <= 0) fire();
      else (this.deps.setTimer ?? ((fn, ms) => void setTimeout(fn, ms).unref()))(fire, delayMs);
    } catch (e) {
      this.lastError = (e as Error).message;
    }
  }

  /** POSTs one payload. Throws a message a person can act on. */
  async send(p: NotifyPayload, urlOverride?: string, formatOverride?: NotifyFormat): Promise<void> {
    const url = urlOverride ?? this.url();
    if (!url) throw new NotifyConfigError('No webhook URL is set.');
    const cfg = loadNotifyConfig(this.deps.db);
    const req = buildRequest(url, formatOverride ?? cfg.format, p);
    try {
      const res = await (this.deps.fetchImpl ?? fetch)(url, { method: 'POST', headers: req.headers, body: req.body, redirect: 'manual', signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      this.lastError = null;
    } catch (e) {
      const err = e as Error & { name?: string };
      const msg = err.name === 'TimeoutError' ? 'the server did not answer in time' : err.message;
      this.lastError = `Could not deliver the notification: ${msg}`;
      throw new Error(this.lastError);
    }
  }
}
