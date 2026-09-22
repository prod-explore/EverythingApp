import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type Database from 'better-sqlite3';
import { deleteProviderKeyRow, getProviderKeyRow, upsertProviderKeyRow } from '../db.js';

const MIN_SECRET_LENGTH = 32;
const AAD_PREFIX = 'everythingapp:provider-key:v1:';

export type VaultReadResult =
  | { status: 'ok'; key: string; last4: string }
  | { status: 'empty' }
  /** A key is stored but KEY_VAULT_SECRET can't open it (secret changed/rotated) — user must re-enter the key. */
  | { status: 'undecryptable'; last4: string };

/**
 * Encrypts provider API keys at rest.
 *
 * - AES-256-GCM, a fresh random IV per write, and a per-row random salt fed to
 *   scrypt together with KEY_VAULT_SECRET, so the same secret never yields the
 *   same derived key twice.
 * - The provider id is bound in as AAD: a ciphertext copied from the
 *   `anthropic` row into the `gemini` row fails authentication instead of
 *   quietly sending one provider's key to another.
 * - KEY_VAULT_SECRET lives in the process environment, not the database, so a
 *   stolen everythingapp.db (or a backup of it) is not enough on its own.
 *
 * What this does NOT defend against: someone who has both the database and the
 * environment (i.e. root on the Pi), or a compromised server process — the key
 * necessarily exists in memory while a request is in flight. It also isn't
 * reachable from the sandbox: the sandbox container never gets the secret, the
 * db path, or docker.sock (Master Brief §0).
 */
export class KeyVault {
  private readonly secret: string | null;

  constructor(
    private readonly db: Database.Database,
    secret: string | undefined = process.env['KEY_VAULT_SECRET'],
  ) {
    this.secret = secret && secret.length >= MIN_SECRET_LENGTH ? secret : null;
  }

  /** False when KEY_VAULT_SECRET is missing or too short — saving keys is refused, reading env-fallback keys still works. */
  get enabled(): boolean {
    return this.secret !== null;
  }

  get disabledReason(): string | null {
    return this.enabled
      ? null
      : `KEY_VAULT_SECRET is not set (or shorter than ${MIN_SECRET_LENGTH} characters). Generate one with: openssl rand -hex 32`;
  }

  set(provider: string, apiKey: string): { last4: string } {
    if (!this.secret) throw new Error(this.disabledReason ?? 'key vault disabled');
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const derived = scryptSync(this.secret, salt, 32);
    const cipher = createCipheriv('aes-256-gcm', derived, iv);
    cipher.setAAD(Buffer.from(AAD_PREFIX + provider));
    const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
    const last4 = apiKey.slice(-4);
    upsertProviderKeyRow(this.db, {
      provider,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      last4,
    });
    return { last4 };
  }

  read(provider: string): VaultReadResult {
    const row = getProviderKeyRow(this.db, provider);
    if (!row) return { status: 'empty' };
    if (!this.secret) return { status: 'undecryptable', last4: row.last4 };
    try {
      const derived = scryptSync(this.secret, Buffer.from(row.salt, 'base64'), 32);
      const decipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(row.iv, 'base64'));
      decipher.setAAD(Buffer.from(AAD_PREFIX + provider));
      decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
      const key = Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8');
      return { status: 'ok', key, last4: row.last4 };
    } catch {
      return { status: 'undecryptable', last4: row.last4 };
    }
  }

  /** Cheap metadata for the UI — never touches the ciphertext, so it works even with the vault disabled. */
  hasKey(provider: string): { present: boolean; last4: string | null } {
    const row = getProviderKeyRow(this.db, provider);
    return row ? { present: true, last4: row.last4 } : { present: false, last4: null };
  }

  delete(provider: string): boolean {
    return deleteProviderKeyRow(this.db, provider);
  }
}
