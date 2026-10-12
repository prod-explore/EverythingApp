import type Database from 'better-sqlite3';
import type { LlmClient } from '../anthropic-loop.js';
import { getToolCallMeta, setToolCallMeta } from '../db.js';
import { ModelCatalog, type CatalogModel, type DiscoveryResult } from './catalog.js';
import { KeyVault } from './key-vault.js';
import { OpenAiCompatClient, type RetryInfo } from './openai-compat.js';
import { PROVIDER_PRESETS, findPreset, getModelInfo, normalizeModelId, parseModelId, type ModelInfo, type ProviderId, type ProviderRecord } from './registry.js';

export class ProviderNotConfiguredError extends Error {
  constructor(
    readonly provider: ProviderId,
    detail: string,
  ) {
    super(detail);
    this.name = 'ProviderNotConfiguredError';
  }
}

export class UnknownModelError extends Error {
  constructor(readonly modelId: string, detail?: string) {
    super(detail ?? `Unknown model "${modelId}" — pick one from the model list.`);
    this.name = 'UnknownModelError';
  }
}

export type KeySource = 'vault' | null;

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  baseUrl: string;
  flavor: ProviderRecord['flavor'];
  enabled: boolean;
  keyOptional: boolean;
  concurrency: number | null;
  configured: boolean;
  source: KeySource;
  /** Last four characters of the stored key — enough to tell keys apart, useless to an attacker. */
  last4: string | null;
  /** A key is stored but can't be decrypted with the current KEY_VAULT_SECRET. */
  needsReentry: boolean;
  keyHint: string;
  modelCount: number;
  enabledModelCount: number;
}

export interface ResolvedModel {
  provider: ProviderId;
  info: ModelInfo;
  client: LlmClient;
}

export type PickerModel = ModelInfo & { available: boolean; providerLabel: string; pricingKnown: boolean };

export interface RouterOptions {
  db: Database.Database;
  vault?: KeyVault;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Tests: serve every model from this client instead of building HTTP clients. Also treated as "configured". */
  llmOverride?: LlmClient;
  /** Fired before each wait while a provider is busy (429/5xx) — wire it to the log / UI. */
  onProviderRetry?: (info: RetryInfo) => void;
}

/** Gemini's free tier rate-limits hard at peak hours: keep retrying for this long (GEMINI_RETRY_BUDGET_HOURS, 0 = classic 2 retries). */
function geminiRetryBudgetMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env['GEMINI_RETRY_BUDGET_HOURS'];
  const hours = raw === undefined || raw === '' ? 12 : Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : undefined;
}

/**
 * Single answer to "which client talks to model X, and does it have a key?".
 *
 * Every provider is the same thing — a base URL, a key and a dialect — so there is one code path for MindGate,
 * Gemini, OpenRouter and a LAN server alike. Keys are resolved at call time, so saving or deleting a key in
 * Settings takes effect on the very next turn with no restart. Decrypted keys are cached in memory only until
 * that provider's key changes.
 */
export class ProviderRouter {
  readonly vault: KeyVault;
  readonly catalog: ModelCatalog;
  private readonly env: NodeJS.ProcessEnv;
  private readonly keyCache = new Map<string, string>();

  /** Settable after construction (the app shell only exists once the router does). */
  onProviderRetry?: (info: RetryInfo) => void;

  constructor(private readonly opts: RouterOptions) {
    this.onProviderRetry = opts.onProviderRetry;
    this.env = opts.env ?? process.env;
    this.vault = opts.vault ?? new KeyVault(opts.db, this.env['KEY_VAULT_SECRET'] ?? '');
    this.catalog = new ModelCatalog(opts.db, this.env);
  }

  // ── keys ──────────────────────────────────────────────────────────────────

  private resolveKey(provider: ProviderRecord): string | null {
    const cached = this.keyCache.get(provider.keyRef);
    if (cached) return cached;
    const fromVault = this.vault.read(provider.keyRef);
    if (fromVault.status === 'ok') {
      this.keyCache.set(provider.keyRef, fromVault.key);
      return fromVault.key;
    }
    // Keyless local servers (LM Studio, vLLM on the LAN) are allowed when the provider says so.
    return provider.keyOptional ? '' : null;
  }

  saveKey(slug: ProviderId, apiKey: string): { last4: string } {
    const p = this.requireProvider(slug);
    const result = this.vault.set(p.keyRef, apiKey);
    this.keyCache.delete(p.keyRef);
    return result;
  }

  removeKey(slug: ProviderId): boolean {
    const p = this.requireProvider(slug);
    const removed = this.vault.delete(p.keyRef);
    this.keyCache.delete(p.keyRef);
    return removed;
  }

  private requireProvider(slug: ProviderId): ProviderRecord {
    const p = this.catalog.get(slug);
    if (!p) throw new ProviderNotConfiguredError(slug, `Unknown provider "${slug}".`);
    return p;
  }

  /** Removes a provider with its models and its stored key. */
  removeProvider(slug: ProviderId): boolean {
    const removed = this.catalog.remove(slug);
    if (!removed) return false;
    this.vault.delete(removed.keyRef);
    this.keyCache.delete(removed.keyRef);
    return true;
  }

  status(): ProviderStatus[] {
    return this.catalog.list().map(p => {
      const stored = this.vault.hasKey(p.keyRef);
      const key = this.resolveKey(p);
      const models = this.catalog.providerModels(p.slug);
      return {
        id: p.slug,
        label: p.label,
        baseUrl: p.baseUrl,
        flavor: p.flavor,
        enabled: p.enabled,
        keyOptional: p.keyOptional,
        concurrency: p.concurrency,
        configured: key !== null,
        source: stored.present && key ? 'vault' : null,
        last4: stored.present && key ? stored.last4 : null,
        needsReentry: stored.present && key === null,
        keyHint: findPreset(p.slug)?.keyHint ?? '',
        modelCount: models.length,
        enabledModelCount: models.filter(m => m.enabled).length,
      };
    });
  }

  // ── clients ───────────────────────────────────────────────────────────────

  /** Removes the key (and anything that looks like it) from an error message before it can reach a log or the UI. */
  redact(message: string): string {
    let out = message;
    for (const key of this.keyCache.values()) if (key) out = out.split(key).join('[redacted]');
    return out;
  }

  private notConfigured(provider: ProviderRecord): ProviderNotConfiguredError {
    if (this.vault.hasKey(provider.keyRef).present) {
      return new ProviderNotConfiguredError(
        provider.slug,
        `The stored ${provider.label} key can't be decrypted with the current KEY_VAULT_SECRET — re-enter it in Settings → Models.`,
      );
    }
    return new ProviderNotConfiguredError(provider.slug, `No ${provider.label} API key configured — add one in Settings → Models.`);
  }

  private makeClient(provider: ProviderRecord, apiKey: string, withMeta = true): OpenAiCompatClient {
    return new OpenAiCompatClient({
      flavor: provider.flavor,
      baseUrl: provider.baseUrl.replace(/\/+$/, ''),
      apiKey,
      fetchImpl: this.opts.fetchImpl,
      ...(provider.flavor === 'gemini' ? { retryBudgetMs: geminiRetryBudgetMs(this.env) } : {}),
      onRetry: info => this.onProviderRetry?.(info),
      modelInfo: id => getModelInfo(id, this.env),
      upstreamModel: id => parseModelId(normalizeModelId(id))?.upstream ?? id,
      meta: withMeta
        ? { get: id => getToolCallMeta(this.opts.db, id, provider.keyRef), set: (id, meta) => setToolCallMeta(this.opts.db, id, provider.keyRef, meta) }
        : { get: () => null, set: () => {} },
    });
  }

  clientFor(modelId: string): ResolvedModel {
    if (this.opts.llmOverride) {
      const info = getModelInfo(modelId, this.env);
      return { provider: info.provider, info, client: this.opts.llmOverride };
    }
    const id = normalizeModelId(modelId);
    const parsed = parseModelId(id);
    if (!parsed) throw new UnknownModelError(modelId);
    const provider = this.catalog.get(parsed.slug);
    if (!provider) {
      throw new ProviderNotConfiguredError(parsed.slug, `Provider "${parsed.slug}" is not set up — add it in Settings → Models, or pick another model.`);
    }
    const known = this.catalog.providerModels(provider.slug).find(m => m.id === id);
    if (!known) throw new UnknownModelError(modelId);
    if (!provider.enabled) throw new ProviderNotConfiguredError(provider.slug, `Provider "${provider.label}" is switched off in Settings → Models.`);
    if (!known.enabled) throw new UnknownModelError(modelId, `Model "${known.label}" is switched off in Settings → Models.`);
    const key = this.resolveKey(provider);
    if (key === null) throw this.notConfigured(provider);
    return { provider: provider.slug, info: getModelInfo(id, this.env), client: this.makeClient(provider, key) };
  }

  /** True when a turn on `modelId` could start right now (model known and enabled, provider has its key). */
  isAvailable(modelId: string): boolean {
    try { this.clientFor(modelId); return true; } catch { return false; }
  }

  /** Enabled models of enabled providers, annotated with whether their provider currently has a key. Pickers filter by `kind`. */
  models(): PickerModel[] {
    const providers = new Map(this.catalog.list().map(p => [p.slug, p] as const));
    return this.catalog.enabledModels().map(m => {
      const info = getModelInfo(m.id, this.env);
      const p = providers.get(info.provider)!;
      return { ...info, providerLabel: p.label, available: this.opts.llmOverride ? true : this.resolveKey(p) !== null, pricingKnown: info.pricing !== null };
    });
  }

  /** Chat-capable models you could pick for a conversation or an agent right now. */
  chatCandidates(): PickerModel[] {
    return this.models().filter(m => m.kind === 'chat');
  }

  providerModels(slug: ProviderId): CatalogModel[] {
    return this.catalog.providerModels(slug);
  }

  // ── connection testing / discovery ────────────────────────────────────────

  /** Cheap authenticated call used by "Test" in Settings. */
  async test(slug: ProviderId): Promise<{ ok: true } | { ok: false; error: string }> {
    const provider = this.catalog.get(slug);
    if (!provider) return { ok: false, error: `unknown provider '${slug}'` };
    const key = this.resolveKey(provider);
    if (key === null) return { ok: false, error: this.notConfigured(provider).message };
    try {
      await this.makeClient(provider, key, false).ping();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.redact((err as Error).message) };
    }
  }

  /** `GET {base}/models` → catalog. Safe to call repeatedly; user overrides and hand-added models survive. */
  async refreshModels(slug: ProviderId): Promise<({ ok: true } & DiscoveryResult) | { ok: false; error: string }> {
    const provider = this.catalog.get(slug);
    if (!provider) return { ok: false, error: `unknown provider '${slug}'` };
    const key = this.resolveKey(provider);
    if (key === null) return { ok: false, error: this.notConfigured(provider).message };
    try {
      const raw = await this.makeClient(provider, key, false).listModels();
      if (raw.length === 0) return { ok: false, error: 'The provider returned an empty model list — nothing was changed. Add model ids by hand if it has no /models endpoint.' };
      return { ok: true, ...this.catalog.applyDiscovered(slug, raw) };
    } catch (err) {
      return { ok: false, error: this.redact((err as Error).message) };
    }
  }

  /** Presets the "Add provider" form offers, minus the ones already added. */
  availablePresets() {
    const have = new Set(this.catalog.list().map(p => p.slug));
    return PROVIDER_PRESETS.filter(p => !have.has(p.slug)).map(p => ({ slug: p.slug, label: p.label, baseUrl: this.env[p.baseUrlEnv ?? ''] || p.baseUrl, flavor: p.flavor, keyOptional: p.keyOptional, concurrency: p.concurrency, keyHint: p.keyHint }));
  }
}
