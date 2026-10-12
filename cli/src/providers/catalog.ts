import type Database from 'better-sqlite3';
import { getSetting, setSetting } from '../db.js';
import type { CompatFlavor } from './openai-compat.js';
import {
  findPreset,
  formatModelId,
  isModelKind,
  presetBaseUrl,
  setCatalogSnapshot,
  type ModelInfo,
  type ModelKind,
  type Pricing,
  type ProviderRecord,
  type ToolSchemaMode,
} from './registry.js';

/**
 * The model catalog: which providers exist and which models each one offers. Everything here is data in SQLite —
 * adding a provider, discovering its models (`GET {base}/models`), switching a model off, tagging it — and the
 * rest of the app only ever sees the resulting `ModelInfo`s (via the snapshot in registry.ts).
 *
 * A model's effective metadata is layered, later wins:  built-in hint  <  what the provider reported  <  what the
 * user set in Settings. A provider that reports nothing but ids (plain OpenAI-compatible) therefore still works,
 * and a gateway that reports richer metadata (kind, tags, context, status — MindGate) is picked up automatically.
 */

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FLAVORS: readonly CompatFlavor[] = ['generic', 'gemini', 'deepseek', 'mindgate'];
export const isFlavor = (v: unknown): v is CompatFlavor => typeof v === 'string' && (FLAVORS as readonly string[]).includes(v);

/** A provider that lists more models than this gets them switched OFF on discovery (OpenRouter has hundreds); the user enables what they use. */
export const AUTO_ENABLE_LIMIT = 40;

/** Output-token floor for thinking models (the answer would otherwise be cut off by the reasoning). */
const REASONING_OUTPUT_FLOOR = 16000;

/** The editable / reportable part of a model. */
export interface ModelFields {
  label?: string;
  kind?: ModelKind;
  tags?: string[];
  description?: string;
  supportsImages?: boolean;
  toolSchemaMode?: ToolSchemaMode;
  contextLength?: number;
  minOutputTokens?: number;
  /** USD per million tokens. */
  pricing?: { input: number; output: number };
  status?: 'online' | 'asleep' | 'waking';
}

export type ModelSource = 'discovered' | 'manual' | 'seed';

export interface CatalogModel extends ModelInfo {
  enabled: boolean;
  source: ModelSource;
  /** Which fields the user has overridden (so the UI can show a reset button). */
  overridden: string[];
}

export function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null; // credentials go in the vault, not the URL
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

// ─── Field parsing ───────────────────────────────────────────────────────────

const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;

export function sanitizeTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const tag = t.trim().toLowerCase();
    if (TAG_RE.test(tag) && !out.includes(tag)) out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}

const finiteNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Validates untrusted metadata (an API body, a stored JSON blob) into ModelFields — unknown or malformed keys are dropped. */
export function sanitizeFields(raw: unknown): ModelFields {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const f: ModelFields = {};
  if (typeof o['label'] === 'string' && o['label'].trim()) f.label = o['label'].trim().slice(0, 100);
  if (isModelKind(o['kind'])) f.kind = o['kind'];
  const tags = sanitizeTags(o['tags']);
  if (tags) f.tags = tags;
  if (typeof o['description'] === 'string') f.description = o['description'].trim().slice(0, 300);
  if (typeof o['supportsImages'] === 'boolean') f.supportsImages = o['supportsImages'];
  if (o['toolSchemaMode'] === 'full' || o['toolSchemaMode'] === 'flat' || o['toolSchemaMode'] === 'none') f.toolSchemaMode = o['toolSchemaMode'];
  const ctx = finiteNum(o['contextLength']);
  if (ctx !== undefined) f.contextLength = Math.trunc(ctx);
  const minOut = finiteNum(o['minOutputTokens']);
  if (minOut !== undefined) f.minOutputTokens = Math.trunc(minOut);
  const p = o['pricing'] as Record<string, unknown> | null | undefined;
  if (p && finiteNum(p['input']) !== undefined && finiteNum(p['output']) !== undefined) f.pricing = { input: p['input'] as number, output: p['output'] as number };
  if (o['status'] === 'online' || o['status'] === 'asleep' || o['status'] === 'waking') f.status = o['status'];
  return f;
}

function guessKind(id: string): ModelKind {
  const s = id.toLowerCase();
  if (/embed/.test(s)) return 'embedding';
  if (/\b(tts)\b|-tts|text-to-speech|speech-synth/.test(s)) return 'tts';
  if (/whisper|transcri|speech-to-text|\bstt\b|-stt/.test(s)) return 'stt';
  if (/imagen|dall-?e|stable-?diffusion|\bsdxl\b|flux|image-gen|-image-|midjourney|higgsfield/.test(s)) return 'image';
  return 'chat';
}

/**
 * One entry of `GET {base}/models` → our ModelFields. Understands the plain OpenAI shape (`id` only), OpenRouter's
 * extensions (`name`, `context_length`, `pricing.prompt/completion` as USD per token, `architecture.input_modalities`,
 * `supported_parameters`) and the gateway extensions defined for MindGate: `kind`, `tags`, `description`,
 * `supports` (tools / vision / reasoning), `status`, `pricing.input/output` as USD per million tokens.
 */
export function parseDiscoveredModel(raw: unknown): { id: string; reported: ModelFields } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = (typeof o['id'] === 'string' ? o['id'].trim() : '').replace(/^models\//, '');
  if (!id || id.length > 200 || /\s/.test(id)) return null;

  const f: ModelFields = {};
  const name = typeof o['name'] === 'string' ? o['name'].trim().replace(/^models\//, '') : '';
  if (name && name !== id) f.label = name.slice(0, 100);
  f.kind = isModelKind(o['kind']) ? o['kind'] : guessKind(id);
  const tags = sanitizeTags(o['tags']);
  if (tags) f.tags = tags;
  if (typeof o['description'] === 'string' && o['description'].trim()) f.description = o['description'].trim().slice(0, 300);
  const ctx = finiteNum(o['context_length']) ?? finiteNum(o['contextLength']);
  if (ctx !== undefined) f.contextLength = Math.trunc(ctx);
  if (o['status'] === 'online' || o['status'] === 'asleep' || o['status'] === 'waking') f.status = o['status'];

  if (Array.isArray(o['supports'])) {
    const supports = o['supports'].filter((s): s is string => typeof s === 'string');
    if (supports.includes('vision')) f.supportsImages = true;
    if (!supports.includes('tools')) f.toolSchemaMode = 'none';
  }
  if (o['tool_schema'] === 'full' || o['tool_schema'] === 'flat' || o['tool_schema'] === 'none') f.toolSchemaMode = o['tool_schema'];
  const arch = o['architecture'] as { input_modalities?: unknown } | undefined;
  if (arch && Array.isArray(arch.input_modalities) && arch.input_modalities.includes('image')) f.supportsImages = true;
  if (Array.isArray(o['supported_parameters']) && !o['supported_parameters'].includes('tools')) f.toolSchemaMode = 'none';

  const p = o['pricing'] as Record<string, unknown> | undefined;
  if (p && typeof p === 'object') {
    const perToken = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN);
    const prompt = perToken(p['prompt']);
    const completion = perToken(p['completion']);
    if (Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0) {
      f.pricing = { input: prompt * 1e6, output: completion * 1e6 };
    } else if (finiteNum(p['input']) !== undefined && finiteNum(p['output']) !== undefined) {
      f.pricing = { input: p['input'] as number, output: p['output'] as number };
    }
  }
  // Priced at zero and not labelled otherwise: it is a free model.
  if (!f.tags && f.pricing && f.pricing.input === 0 && f.pricing.output === 0) f.tags = ['free'];
  return { id, reported: f };
}

const toPricing = (p: { input: number; output: number }): Pricing => ({ input: p.input, output: p.output, cacheWrite: p.input, cacheRead: p.input / 10 });

const parseJson = (s: unknown): ModelFields => {
  if (typeof s !== 'string') return {};
  try { return sanitizeFields(JSON.parse(s)); } catch { return {}; }
};

// ─── Schema ──────────────────────────────────────────────────────────────────

export function migrateCatalogSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      slug         TEXT PRIMARY KEY,
      label        TEXT NOT NULL,
      base_url     TEXT NOT NULL,
      key_optional INTEGER NOT NULL DEFAULT 0,
      flavor       TEXT NOT NULL DEFAULT 'generic',
      enabled      INTEGER NOT NULL DEFAULT 1,
      concurrency  INTEGER,
      key_ref      TEXT NOT NULL,
      position     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS provider_models (
      provider   TEXT NOT NULL,
      model_id   TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      source     TEXT NOT NULL DEFAULT 'discovered',
      reported   TEXT NOT NULL DEFAULT '{}',
      overrides  TEXT NOT NULL DEFAULT '{}',
      position   INTEGER NOT NULL DEFAULT 0,
      last_seen  TEXT,
      PRIMARY KEY (provider, model_id)
    );
  `);
}

const tableExists = (db: Database.Database, name: string): boolean =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

interface ProviderRow { slug: string; label: string; base_url: string; key_optional: number; flavor: string; enabled: number; concurrency: number | null; key_ref: string }
interface ModelRow { provider: string; model_id: string; enabled: number; source: string; reported: string; overrides: string }

const toRecord = (r: ProviderRow): ProviderRecord => ({
  slug: r.slug,
  label: r.label,
  baseUrl: r.base_url,
  keyOptional: r.key_optional === 1,
  flavor: isFlavor(r.flavor) ? r.flavor : 'generic',
  enabled: r.enabled === 1,
  concurrency: r.concurrency,
  keyRef: r.key_ref,
});

export interface DiscoveryResult {
  /** Models the provider reported. */
  count: number;
  added: number;
  removed: number;
}

export class ModelCatalog {
  constructor(
    private readonly db: Database.Database,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    migrateCatalogSchema(db);
    this.importLegacy();
    this.migrateStoredModelIds();
    this.sync();
  }

  // ── providers ──────────────────────────────────────────────────────────────

  list(): ProviderRecord[] {
    return (this.db.prepare(`SELECT * FROM providers ORDER BY position, rowid`).all() as ProviderRow[]).map(toRecord);
  }

  get(slug: string): ProviderRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM providers WHERE slug = ?`).get(slug) as ProviderRow | undefined;
    return r ? toRecord(r) : undefined;
  }

  create(input: { slug: string; label: string; baseUrl: string; keyOptional: boolean; flavor: CompatFlavor; concurrency?: number | null; keyRef?: string }): ProviderRecord {
    const pos = (this.db.prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM providers`).get() as { p: number }).p;
    this.db
      .prepare(`INSERT INTO providers (slug, label, base_url, key_optional, flavor, concurrency, key_ref, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.slug, input.label, input.baseUrl, input.keyOptional ? 1 : 0, input.flavor, input.concurrency ?? null, input.keyRef ?? input.slug, pos);
    this.sync();
    return this.get(input.slug)!;
  }

  update(slug: string, patch: Partial<{ label: string; baseUrl: string; keyOptional: boolean; flavor: CompatFlavor; enabled: boolean; concurrency: number | null }>): boolean {
    const r = this.db
      .prepare(`
        UPDATE providers SET
          label = COALESCE(?, label), base_url = COALESCE(?, base_url), key_optional = COALESCE(?, key_optional),
          flavor = COALESCE(?, flavor), enabled = COALESCE(?, enabled)
        WHERE slug = ?`)
      .run(
        patch.label ?? null,
        patch.baseUrl ?? null,
        patch.keyOptional === undefined ? null : patch.keyOptional ? 1 : 0,
        patch.flavor ?? null,
        patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
        slug,
      );
    if (!r.changes) return false;
    if (patch.concurrency !== undefined) this.db.prepare(`UPDATE providers SET concurrency = ? WHERE slug = ?`).run(patch.concurrency, slug);
    this.sync();
    return true;
  }

  /** Removes the provider and its models; returns the vault row name so the caller can drop the key. */
  remove(slug: string): { keyRef: string } | null {
    const p = this.get(slug);
    if (!p) return null;
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM provider_models WHERE provider = ?`).run(slug);
      this.db.prepare(`DELETE FROM providers WHERE slug = ?`).run(slug);
    })();
    this.sync();
    return { keyRef: p.keyRef };
  }

  // ── models ─────────────────────────────────────────────────────────────────

  /** All of a provider's models (enabled or not) with their effective metadata. */
  providerModels(slug: string): CatalogModel[] {
    return this.build().filter(m => m.provider === slug);
  }

  /** Enabled chat-capable models of enabled providers, in catalog order — what pickers and the orchestrator choose from. */
  enabledModels(): CatalogModel[] {
    const live = new Set(this.list().filter(p => p.enabled).map(p => p.slug));
    return this.build().filter(m => m.enabled && live.has(m.provider));
  }

  /** Stores a provider's `/models` answer. Models the user touched (overrides) or added by hand are never dropped. */
  applyDiscovered(slug: string, rawModels: unknown[]): DiscoveryResult {
    const parsed = new Map<string, ModelFields>();
    for (const raw of rawModels) {
      const m = parseDiscoveredModel(raw);
      if (m && !parsed.has(m.id)) parsed.set(m.id, m.reported);
    }
    const autoEnable = parsed.size <= AUTO_ENABLE_LIMIT;
    const existing = new Map((this.db.prepare(`SELECT * FROM provider_models WHERE provider = ?`).all(slug) as ModelRow[]).map(r => [r.model_id, r]));
    const now = new Date().toISOString();
    let added = 0;
    let removed = 0;
    this.db.transaction(() => {
      let pos = (this.db.prepare(`SELECT COALESCE(MAX(position), 0) AS p FROM provider_models WHERE provider = ?`).get(slug) as { p: number }).p;
      for (const [id, reported] of parsed) {
        const row = existing.get(id);
        if (row) {
          this.db
            .prepare(`UPDATE provider_models SET reported = ?, last_seen = ?, source = CASE WHEN source = 'seed' THEN 'discovered' ELSE source END WHERE provider = ? AND model_id = ?`)
            .run(JSON.stringify(reported), now, slug, id);
        } else {
          this.db
            .prepare(`INSERT INTO provider_models (provider, model_id, enabled, source, reported, position, last_seen) VALUES (?, ?, ?, 'discovered', ?, ?, ?)`)
            .run(slug, id, autoEnable ? 1 : 0, JSON.stringify(reported), ++pos, now);
          added++;
        }
      }
      for (const [id, row] of existing) {
        if (parsed.has(id) || row.source === 'manual') continue;
        if (Object.keys(parseJson(row.overrides)).length > 0) continue; // the user customised it — keep
        this.db.prepare(`DELETE FROM provider_models WHERE provider = ? AND model_id = ?`).run(slug, id);
        removed++;
      }
    })();
    this.sync();
    return { count: parsed.size, added, removed };
  }

  /** Adds a model by hand (a provider with no `/models`, or one that hides some). */
  addManual(slug: string, upstream: string, fields: ModelFields = {}): boolean {
    const id = upstream.trim();
    if (!this.get(slug) || !id || id.length > 200 || /\s/.test(id)) return false;
    const pos = (this.db.prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM provider_models WHERE provider = ?`).get(slug) as { p: number }).p;
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO provider_models (provider, model_id, enabled, source, reported, position) VALUES (?, ?, 1, 'manual', ?, ?)`)
      .run(slug, id, JSON.stringify(fields), pos);
    this.sync();
    return r.changes > 0;
  }

  /**
   * Edits one model. `enabled` switches it on/off; for the metadata fields a value sets the user's override and
   * `null` clears it (back to what the provider reports).
   */
  updateModel(modelId: string, patch: { enabled?: boolean; fields?: { [K in keyof ModelFields]?: ModelFields[K] | null } }): boolean {
    const target = this.locate(modelId);
    if (!target) return false;
    const row = this.db.prepare(`SELECT overrides FROM provider_models WHERE provider = ? AND model_id = ?`).get(target.provider, target.upstream) as { overrides: string } | undefined;
    if (!row) return false;
    const overrides: Record<string, unknown> = { ...parseJson(row.overrides) };
    const incoming = (patch.fields ?? {}) as Record<string, unknown>;
    const clean = sanitizeFields(incoming) as Record<string, unknown>;
    for (const key of Object.keys(incoming)) {
      if (incoming[key] === null) delete overrides[key];
      else if (key in clean) overrides[key] = clean[key];
    }
    this.db
      .prepare(`UPDATE provider_models SET overrides = ?, enabled = COALESCE(?, enabled) WHERE provider = ? AND model_id = ?`)
      .run(JSON.stringify(overrides), patch.enabled === undefined ? null : patch.enabled ? 1 : 0, target.provider, target.upstream);
    this.sync();
    return true;
  }

  removeModel(modelId: string): boolean {
    const target = this.locate(modelId);
    if (!target) return false;
    const r = this.db.prepare(`DELETE FROM provider_models WHERE provider = ? AND model_id = ?`).run(target.provider, target.upstream);
    this.sync();
    return r.changes > 0;
  }

  private locate(modelId: string): { provider: string; upstream: string } | null {
    const m = /^@([a-z0-9][a-z0-9-]{0,31})\/(.+)$/.exec(modelId);
    return m ? { provider: m[1]!, upstream: m[2]! } : null;
  }

  // ── snapshot ───────────────────────────────────────────────────────────────

  private build(): CatalogModel[] {
    const providers = new Map(this.list().map(p => [p.slug, p] as const));
    const order = [...providers.keys()];
    const rows = (this.db.prepare(`SELECT * FROM provider_models ORDER BY position, rowid`).all() as ModelRow[])
      .filter(r => providers.has(r.provider))
      .sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
    return rows.map(r => {
      const provider = providers.get(r.provider)!;
      const rep = parseJson(r.reported);
      const ov = parseJson(r.overrides);
      const pricing = ov.pricing ? toPricing(ov.pricing) : rep.pricing ? toPricing(rep.pricing) : null;
      const tags = ov.tags ?? rep.tags ?? [];
      return {
        id: formatModelId(r.provider, r.model_id),
        provider: r.provider,
        upstream: r.model_id,
        label: ov.label ?? rep.label ?? r.model_id,
        kind: ov.kind ?? rep.kind ?? 'chat',
        tags,
        description: ov.description ?? rep.description ?? '',
        pricing,
        supportsImages: ov.supportsImages ?? rep.supportsImages ?? false,
        // Thinking models spend output tokens on reasoning before the answer: Gemini always does, others say so with the tag.
        minOutputTokens: ov.minOutputTokens ?? rep.minOutputTokens ?? (provider.flavor === 'gemini' || tags.includes('reasoning') ? REASONING_OUTPUT_FLOOR : undefined),
        toolSchemaMode: ov.toolSchemaMode ?? rep.toolSchemaMode,
        contextLength: ov.contextLength ?? rep.contextLength,
        status: rep.status,
        enabled: r.enabled === 1,
        source: (r.source === 'manual' || r.source === 'seed' ? r.source : 'discovered') as ModelSource,
        overridden: Object.keys(ov),
      };
    });
  }

  /** Re-reads the catalog into the module-level snapshot (called after every write). */
  sync(): void {
    const providers = new Map(this.list().map(p => [p.slug, p] as const));
    const models = new Map<string, ModelInfo>();
    for (const m of this.build()) {
      const { source: _source, overridden: _overridden, ...info } = m;
      models.set(m.id, info);
    }
    setCatalogSnapshot({ providers, models });
  }

  // ── one-time import of the pre-unification setup ───────────────────────────

  /**
   * Before the unification the app had four hard-wired providers (anthropic, gemini, deepseek, mindgate) plus
   * "custom providers" from Settings. Providers that were actually in use are carried over — custom ones with
   * their model lists, built-in ones when a key was stored for them — and stored model ids are rewritten to
   * `@provider/model`.
   * Anthropic is gone on purpose: a leftover Anthropic key stays in the vault, unused.
   */
  private importLegacy(): void {
    if (getSetting(this.db, 'catalog_v1')) return;
    this.db.transaction(() => {
      const hasKeys = tableExists(this.db, 'provider_keys');
      const keyed = new Set<string>(hasKeys ? (this.db.prepare(`SELECT provider FROM provider_keys`).all() as Array<{ provider: string }>).map(r => r.provider) : []);

      if (tableExists(this.db, 'custom_providers')) {
        const rows = this.db.prepare(`SELECT * FROM custom_providers ORDER BY created_at`).all() as Array<Record<string, unknown>>;
        for (const r of rows) {
          const slug = String(r['slug']);
          if (!SLUG_RE.test(slug) || this.get(slug)) continue;
          this.create({ slug, label: String(r['label'] ?? slug), baseUrl: String(r['base_url']), keyOptional: r['key_optional'] === 1, flavor: 'generic', keyRef: `custom:${slug}` });
          let models: unknown[] = [];
          try { models = JSON.parse(String(r['models'] ?? '[]')) as unknown[]; } catch { /* no models */ }
          for (const m of models) {
            const o = (m ?? {}) as Record<string, unknown>;
            if (typeof o['id'] === 'string') this.addManual(slug, o['id'], sanitizeFields({ label: o['label'], supportsImages: o['supportsImages'], toolSchemaMode: o['toolSchemaMode'], pricing: o['pricing'] }));
          }
        }
      }

      // Built-in providers that had a stored key come over as providers; their models appear with the first "Refresh models".
      for (const slug of ['mindgate', 'gemini', 'deepseek']) {
        const preset = findPreset(slug);
        if (!preset || !keyed.has(slug) || this.get(slug)) continue;
        this.create({ slug, label: preset.label, baseUrl: presetBaseUrl(preset, this.env), keyOptional: preset.keyOptional, flavor: preset.flavor, concurrency: preset.concurrency });
      }

      setSetting(this.db, 'catalog_v1', '1');
    })();
  }

  /**
   * Model ids stored before the provider unification were bare and the provider was implied by the name. One-time
   * rewrite to `@provider/model` everywhere they are kept. The rule needs no list of model names: the old app had
   * exactly four providers — `claude-*` (Anthropic, gone: left alone), `gemini*`, `deepseek*`, and everything else
   * was a MindGate model.
   */
  private migrateStoredModelIds(): void {
    if (getSetting(this.db, 'catalog_v2')) return;
    this.db.transaction(() => {
      const remap = (table: string, column: string, where = '') => {
        if (!tableExists(this.db, table)) return;
        const rows = this.db.prepare(`SELECT DISTINCT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL ${where}`).all() as Array<{ v: string }>;
        for (const { v } of rows) {
          const next = legacyModelId(v);
          if (next !== v) this.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ? ${where}`).run(next, v);
        }
      };
      remap('conversations', 'model');
      remap('approval_grants', 'subject_id', `AND subject_type = 'model'`);
      remap('usage_log', 'model');
      remap('runs', 'model');
      remap('subagent_runs', 'model');

      // A default pointing at a model that no longer exists (e.g. the old "claude-sonnet-5") is cleared, so new
      // chats pick a usable model instead of failing; one that is in the catalog is kept.
      const current = getSetting(this.db, 'default_model');
      if (current) {
        const next = legacyModelId(current);
        const parsed = /^@([a-z0-9][a-z0-9-]{0,31})\/(.+)$/.exec(next);
        const exists = parsed && this.db.prepare(`SELECT 1 FROM provider_models WHERE provider = ? AND model_id = ?`).get(parsed[1], parsed[2]);
        setSetting(this.db, 'default_model', exists ? next : '');
      }
      setSetting(this.db, 'catalog_v2', '1');
    })();
  }
}

/** Bare pre-unification id → canonical id (see migrateStoredModelIds); canonical ids and `claude-*` pass through. */
export function legacyModelId(raw: string): string {
  if (!raw || /^@[a-z0-9][a-z0-9-]{0,31}\/.+$/.test(raw)) return raw;
  const id = raw.toLowerCase();
  if (id.startsWith('claude')) return raw;
  if (id.startsWith('gemini')) return formatModelId('gemini', raw);
  if (id.startsWith('deepseek')) return formatModelId('deepseek', raw);
  return formatModelId('mindgate', raw);
}
