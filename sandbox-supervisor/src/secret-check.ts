/**
 * Startup check for shared secrets (bearer tokens between services, the web login token).
 *
 * `.env.example` ships obvious placeholders; docker-compose only checks that a value is non-empty, so a copied
 * example would otherwise start happily with a secret everybody knows. This refuses placeholders, short values and
 * values made of a few repeated characters. `ALLOW_WEAK_SECRETS=true` turns the refusal into a warning (local dev).
 *
 * The same file lives in cli, sandbox-supervisor, sandbox-mcp, playwright-mcp and git-proxy — every package is built
 * on its own in Docker, so there is no shared module to import it from.
 */

export const MIN_SECRET_LENGTH = 24;

const PLACEHOLDER = /^(change[-_ ]?me|your[-_ ].*|.*[-_ ]here|secret|password|token|test|ci|example|todo|x+)$/i;

/** Why a secret is unacceptable, or null when it is fine. */
export function weakSecretReason(value: string): string | null {
  if (PLACEHOLDER.test(value.trim())) return 'it is a placeholder from .env.example';
  if (value.length < MIN_SECRET_LENGTH) return `it is shorter than ${MIN_SECRET_LENGTH} characters`;
  if (new Set(value).size < 8) return 'it has too few distinct characters';
  return null;
}

/**
 * Throws when `value` is a weak secret (and warns instead when ALLOW_WEAK_SECRETS is set).
 * An unset value is left to the caller — "required" is a different error.
 */
export function assertStrongSecret(name: string, value: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (!value) return;
  const reason = weakSecretReason(value);
  if (!reason) return;
  const message = `${name} is too weak: ${reason}. Generate one with: openssl rand -hex 32`;
  if (/^(1|true|yes|on)$/i.test(env['ALLOW_WEAK_SECRETS'] ?? '')) {
    console.warn(`[secrets] ${message} (allowed by ALLOW_WEAK_SECRETS)`);
    return;
  }
  throw new Error(message);
}
