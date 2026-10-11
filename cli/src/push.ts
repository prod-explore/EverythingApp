import type Database from 'better-sqlite3';
import webpush from 'web-push';
import type { KeyVault } from './providers/key-vault.js';
import { getSetting, setSetting } from './db.js';

export interface PushSubscriptionJson { endpoint: string; keys: { p256dh: string; auth: string } }

type Sender = (sub: PushSubscriptionJson, payload: string, vapid: { publicKey: string; privateKey: string; subject: string }) => Promise<unknown>;

/**
 * Web Push for urgent Gazeta items. VAPID keys are generated on first use; the private key lives in the
 * encrypted key vault (public key in settings). Without a vault secret push stays off — nothing is stored in clear.
 */
export class PushService {
  constructor(
    private readonly db: Database.Database,
    private readonly vault: KeyVault,
    private readonly send: Sender = (sub, payload, v) =>
      webpush.sendNotification(sub, payload, { vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey }, TTL: 3600, urgency: 'high' }),
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  }

  get enabled(): boolean { return this.vault.enabled; }

  private keys(): { publicKey: string; privateKey: string } | null {
    if (!this.vault.enabled) return null;
    const pub = getSetting(this.db, 'vapid_public');
    const priv = pub ? this.vault.read('webpush-vapid') : null;
    if (pub && priv && 'key' in priv) return { publicKey: pub, privateKey: priv.key };
    const k = webpush.generateVAPIDKeys();
    this.vault.set('webpush-vapid', k.privateKey);
    setSetting(this.db, 'vapid_public', k.publicKey);
    return k;
  }

  publicKey(): string | null { return this.keys()?.publicKey ?? null; }

  subscribe(sub: PushSubscriptionJson): void {
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('invalid subscription');
    this.db.prepare(`INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`).run(sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  }

  unsubscribe(endpoint: string): void { this.db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint); }

  count(): number { return (this.db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).get() as { n: number }).n; }

  /** Sends to every subscription; dead ones (404/410) are pruned. Never throws — a failed push must not break the caller. */
  async notify(msg: { title: string; body?: string; url?: string }): Promise<number> {
    const k = this.keys();
    if (!k) return 0;
    const subs = this.db.prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions`).all() as Array<{ endpoint: string; p256dh: string; auth: string }>;
    const payload = JSON.stringify({ title: msg.title.slice(0, 100), body: (msg.body ?? '').slice(0, 200), url: msg.url ?? '/' });
    let sent = 0;
    await Promise.all(subs.map(async s => {
      try {
        await this.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { ...k, subject: 'mailto:admin@localhost.invalid' });
        sent++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) this.unsubscribe(s.endpoint);
      }
    }));
    return sent;
  }
}
