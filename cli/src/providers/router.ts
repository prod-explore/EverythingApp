import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import type { AnthropicBatchLike } from '../batch.js';
import type { LlmClient } from '../anthropic-loop.js';
import { getToolCallMeta, setToolCallMeta } from '../db.js';
import { KeyVault } from './key-vault.js';
import { OpenAiCompatClient, ProviderHttpError, type CompatFlavor } from './openai-compat.js';
import { PROVIDERS, PROVIDER_IDS, getModelInfo, listCatalog, type ModelInfo, type ProviderId } from './registry.js';

export class ProviderNotConfiguredError extends Error {
  constructor(
    readonly provider: ProviderId,
    detail: string,
  ) {
    super(detail);
    this.name = 'ProviderNotConfiguredError';
  }
}

export type KeySource = 'vault' | 'env' | null;

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  configured: boolean;
  source: KeySource;
  /** Last four characters of the stored key — enough to tell keys apart, useless to an attacker. */
  last4: string | null;
  /** A key is stored but can't be decrypted with the current KEY_VAULT_SECRET. */
  needsReentry: boolean;
  keyHint: string;
}

export interface ResolvedModel {
  provider: ProviderId;
  info: ModelInfo;
  client: LlmClient;
}

export interface RouterOptions {
  db: Database.Database;
  vault?: KeyVault;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Tests: use this instead of constructing an Anthropic SDK client. Also treated as "configured". */
  anthropicOverride?: LlmClient & AnthropicBatchLike;
}

/**
 * Single answer to "which client talks to model X, and does it have a key?".
 *
 * Keys are resolved at call time (vault first, then — Anthropic only — the
 * legacy env var), so saving or deleting a key in Settings takes effect on the
 * very next turn with no restart. Decrypted keys are cached in memory only
 * until that provider's key changes.
 */
export class ProviderRouter {
  readonly vault: KeyVault;
  private readonly env: NodeJS.ProcessEnv;
  private readonly keyCache = new Map<ProviderId, string>();
  private anthropicClient: { key: string; client: Anthropic } | null = null;

  constructor(private readonly opts: RouterOptions) {
    this.env = opts.env ?? process.env;
    this.vault = opts.vault ?? new KeyVault(opts.db, this.env['KEY_VAULT_SECRET']);
  }

  // ── keys ──────────────────────────────────────────────────────────────────

  private resolveKey(provider: ProviderId): { key: string; source: Exclude<KeySource, null> } | null {
    const cached = this.keyCache.get(provider);
    if (cached) return { key: cached, source: 'vault' };

    const fromVault = this.vault.read(provider);
    if (fromVault.status === 'ok') {
      this.keyCache.set(provider, fromVault.key);
      return { key: fromVault.key, source: 'vault' };
    }
    const envName = PROVIDERS[provider].envKeyFallback;
    const envKey = envName ? this.env[envName] : undefined;
    if (envKey) return { key: envKey, source: 'env' };
    return null;
  }

  saveKey(provider: ProviderId, apiKey: string): { last4: string } {
    const result = this.vault.set(provider, apiKey);
    this.keyCache.delete(provider);
    if (provider === 'anthropic') this.anthropicClient = null;
    return result;
  }

  removeKey(provider: ProviderId): boolean {
    const removed = this.vault.delete(provider);
    this.keyCache.delete(provider);
    if (provider === 'anthropic') this.anthropicClient = null;
    return removed;
  }

  status(): ProviderStatus[] {
    return PROVIDER_IDS.map(id => {
      const def = PROVIDERS[id];
      const stored = this.vault.hasKey(id);
      const resolved = this.resolveKey(id);
      return {
        id,
        label: def.label,
        configured: this.opts.anthropicOverride && id === 'anthropic' ? true : resolved !== null,
        source: resolved?.source ?? null,
        last4: resolved?.source === 'vault' ? stored.last4 : null,
        needsReentry: stored.present && resolved?.source !== 'vault',
        keyHint: def.keyHint,
      };
    });
  }

  // ── clients ───────────────────────────────────────────────────────────────

  /** Removes the key (and anything that looks like it) from an error message before it can reach a log or the UI. */
  redact(message: string): string {
    let out = message;
    for (const id of PROVIDER_IDS) {
      const key = this.keyCache.get(id) ?? (id === 'anthropic' ? this.env['ANTHROPIC_API_KEY'] : undefined);
      if (key) out = out.split(key).join('[redacted]');
    }
    return out;
  }

  private notConfigured(provider: ProviderId): ProviderNotConfiguredError {
    const stored = this.vault.hasKey(provider);
    const label = PROVIDERS[provider].label;
    if (stored.present) {
      return new ProviderNotConfiguredError(
        provider,
        `The stored ${label} key can't be decrypted with the current KEY_VAULT_SECRET — re-enter it in Settings → Models.`,
      );
    }
    return new ProviderNotConfiguredError(provider, `No ${label} API key configured — add one in Settings → Models.`);
  }

  /** Raw Anthropic client (chat + Batch API). Used by batch mode, which is Anthropic-only. */
  anthropic(): (LlmClient & AnthropicBatchLike) | null {
    if (this.opts.anthropicOverride) return this.opts.anthropicOverride;
    const resolved = this.resolveKey('anthropic');
    if (!resolved) return null;
    if (this.anthropicClient?.key !== resolved.key) {
      this.anthropicClient = { key: resolved.key, client: new Anthropic({ apiKey: resolved.key }) };
    }
    return this.anthropicClient.client as unknown as LlmClient & AnthropicBatchLike;
  }

  clientFor(modelId: string): ResolvedModel {
    const info = getModelInfo(modelId, this.env);

    if (info.provider === 'anthropic') {
      const client = this.anthropic();
      if (!client) throw this.notConfigured('anthropic');
      return { provider: 'anthropic', info, client };
    }

    const resolved = this.resolveKey(info.provider);
    if (!resolved) throw this.notConfigured(info.provider);
    const def = PROVIDERS[info.provider];
    const client = new OpenAiCompatClient({
      flavor: info.provider as CompatFlavor,
      baseUrl: (def.baseUrlEnv ? this.env[def.baseUrlEnv] : undefined) ?? def.baseUrl!,
      apiKey: resolved.key,
      fetchImpl: this.opts.fetchImpl,
      modelInfo: id => getModelInfo(id, this.env),
      meta: {
        get: id => getToolCallMeta(this.opts.db, id, info.provider),
        set: (id, meta) => setToolCallMeta(this.opts.db, id, info.provider, meta),
      },
    });
    return { provider: info.provider, info, client };
  }

  /** Model catalog annotated with whether the model's provider currently has a key. */
  models(): Array<ModelInfo & { available: boolean }> {
    const configured = new Map(this.status().map(s => [s.id, s.configured]));
    return listCatalog(this.env).map(m => ({ ...m, available: configured.get(m.provider) ?? false }));
  }

  // ── key testing ───────────────────────────────────────────────────────────

  async test(provider: ProviderId): Promise<{ ok: true } | { ok: false; error: string }> {
    const resolved = this.resolveKey(provider);
    if (!resolved && !(provider === 'anthropic' && this.opts.anthropicOverride)) {
      return { ok: false, error: this.notConfigured(provider).message };
    }
    try {
      const f = this.opts.fetchImpl ?? fetch;
      if (provider === 'anthropic') {
        if (!resolved) return { ok: true }; // test double
        const res = await f('https://api.anthropic.com/v1/models?limit=1', {
          headers: { 'x-api-key': resolved.key, 'anthropic-version': '2023-06-01' },
        });
        if (!res.ok) throw new ProviderHttpError('anthropic', res.status, (await res.text()).slice(0, 300));
      } else {
        const def = PROVIDERS[provider];
        const client = new OpenAiCompatClient({
          flavor: provider as CompatFlavor,
          baseUrl: (def.baseUrlEnv ? this.env[def.baseUrlEnv] : undefined) ?? def.baseUrl!,
          apiKey: resolved!.key,
          fetchImpl: this.opts.fetchImpl,
          modelInfo: id => getModelInfo(id, this.env),
          meta: { get: () => null, set: () => {} },
        });
        await client.ping();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.redact((err as Error).message) };
    }
  }
}
