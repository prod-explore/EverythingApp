import { z } from 'zod';
import type { PlaywrightConfig } from '../config.js';
import { checkNavigation, mergePolicy, policyOverrideSchema, type EffectivePolicy, type PolicyOverride } from '../policy.js';
import type { SessionState } from '../browserContext.js';
import { UrlBlockedError } from '../urlSafety.js';
import { guardFor } from '../urlGuardFor.js';

/**
 * Hidden arguments the ORCHESTRATOR sets (like `_conversation_id`). The model must never be able to
 * supply them — the cli strips any model-provided value and injects the project's own.
 */
export const hiddenPolicyArgs = {
  _policy: policyOverrideSchema
    .optional()
    .describe('Internal: project browser policy {domainAllow, domainDeny, js}. Set by the orchestrator, never by the model.'),
  _allow_downloads: z
    .boolean()
    .optional()
    .describe('Internal: the user explicitly allowed downloads/uploads for this call. Set by the orchestrator, never by the model.'),
};

export function envPolicy(config: PlaywrightConfig): PolicyOverride {
  return { domainAllow: config.domainAllow, domainDeny: config.domainDeny, js: config.jsPolicy };
}

export function effectivePolicy(config: PlaywrightConfig, override?: PolicyOverride): EffectivePolicy {
  return mergePolicy(envPolicy(config), override);
}

/** Applies this call's `_policy` (sticky: a call without one keeps the session's last override). */
export function applyCallPolicy(config: PlaywrightConfig, state: SessionState, override: PolicyOverride | undefined): void {
  if (override) state.override = override;
  state.policy = effectivePolicy(config, state.override);
}

/** Runs `fn` with downloads allowed only if this call carried `_allow_downloads: true`. */
export async function withDownloadPermission<T>(state: SessionState, allow: boolean | undefined, fn: () => Promise<T>): Promise<T> {
  state.allowDownloads = allow === true;
  try {
    return await fn();
  } finally {
    state.allowDownloads = false;
  }
}

/**
 * Pre-flight for a URL the model asked to open: domain/scheme policy first (clear, actionable
 * message), then the private-network SSRF guard. Returns an error message or null.
 */
export async function checkTargetUrl(config: PlaywrightConfig, policy: EffectivePolicy, url: string): Promise<string | null> {
  const d = checkNavigation(policy, url);
  if (!d.allowed) return `Error: ${d.reason}`;
  try {
    await guardFor(config).check(url);
  } catch (err) {
    if (err instanceof UrlBlockedError) return `Error: ${err.message}`;
    throw err;
  }
  return null;
}
