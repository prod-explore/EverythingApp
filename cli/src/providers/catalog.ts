import type Database from 'better-sqlite3';
import type { CompatFlavor } from './openai-compat.js';
import {
  formatModelId,
  isModelKind,
  setCatalogSnapshot,
  type ModelInfo,
  type ModelKind,
  type ProviderRecord,
  type ToolSchemaMode,
} from './registry.js';

/**
 * The model catalog: which providers exist and which models each one offers. Everything here is data in SQLite —
 * adding a provider, discovering its models (`GET {base}/models`), switching a model off, tagging it — and the
 * rest of the app only ever sees the resulting `ModelInfo`s (via the snapshot in registry.ts).
 *
 * A model's effective metadata is layered, later wins:  what the provider reported  <  what the user set in
 * Settings. A provider that reports nothing but ids (plain OpenAI-compatible) therefore still works,
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
  supportsEffort?: boolean;
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
  if (typeof o['supportsEffort'] === 'boolean') f.supportsEffort = o['supportsEffort'];
  if (o['toolSchemaMode'] === 'full' || o['toolSchemaMode'] === 'flat' || o['toolSchemaMode'] === 'none') f.toolSchemaMode = o['toolSchemaMode'];
  const ctx = finiteNum(o['contextLength']);
  if (ctx !== undefined) f.contextLength = Math.trunc(ctx);
  const minOut = finiteNum(o['minOutputTokens']);
  if (minOut !== undefined) f.minOutputTokens = Math.trunc(minOut);
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
 * extensions (`name`, `context_length`, `pricing` — only "free" is used —, `architecture.input_modalities`,
 * `supported_parameters`) and the gateway extensions defined for MindGate: `kind`, `tags`, `description`,
 * `supports` (tools / vision / reasoning), `tool_schema`.
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

  if (Array.isArray(o['supports'])) {
    const supports = o['supports'].filter((s): s is string => typeof s === 'string');
    if (supports.includes('vision')) f.supportsImages = true;
    if (supports.includes('reasoning_effort')) f.supportsEffort = true;
    if (!supports.includes('tools')) f.toolSchemaMode = 'none';
  }
  if (o['tool_schema'] === 'full' || o['tool_schema'] === 'flat' || o['tool_schema'] === 'none') f.toolSchemaMode = o['tool_schema'];
  const arch = o['architecture'] as { input_modalities?: unknown } | undefined;
  if (arch && Array.isArray(arch.input_modalities) && arch.input_modalities.includes('image')) f.supportsImages = true;
  if (Array.isArray(o['supported_parameters'])) {
    if (!o['supported_parameters'].includes('tools')) f.toolSchemaMode = 'none';
    if (o['supported_parameters'].includes('reasoning_effort')) f.supportsEffort = true;
  }

  // The app keeps no prices (that is the gateway's job). The one thing taken from a reported price is "costs
  // nothing" — OpenRouter lists `:free` models that way — because the `free` tag drives the cost guard.
  const price = o['pricing'] as Record<string, unknown> | undefined;
  if (!f.tags && price && typeof price === 'object') {
    const zero = (v: unknown) => (typeof v === 'string' || typeof v === 'number') && Number(v) === 0;
    if ((zero(price['prompt']) && zero(price['completion'])) || (zero(price['input']) && zero(price['output']))) f.tags = ['free'];
  }
  return { id, reported: f };
}

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
      retry_min    INTEGER,
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

interface ProviderRow { slug: string; label: string; base_url: string; key_optional: number; flavor: string; enabled: number; concurrency: number | null; retry_min: number | null }
interface ModelRow { provider: string; model_id: string; enabled: number; source: string; reported: string; overrides: string }

const toRecord = (r: ProviderRow): ProviderRecord => ({
  slug: r.slug,
  label: r.label,
  baseUrl: r.base_url,
  keyOptional: r.key_optional === 1,
  flavor: isFlavor(r.flavor) ? r.flavor : 'generic',
  enabled: r.enabled === 1,
  concurrency: r.concurrency,
  retryMin: r.retry_min,
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

  create(input: { slug: string; label: string; baseUrl: string; keyOptional: boolean; flavor: CompatFlavor; concurrency?: number | null; retryMin?: number | null }): ProviderRecord {
    const pos = (this.db.prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM providers`).get() as { p: number }).p;
    this.db
      .prepare(`INSERT INTO providers (slug, label, base_url, key_optional, flavor, concurrency, retry_min, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.slug, input.label, input.baseUrl, input.keyOptional ? 1 : 0, input.flavor, input.concurrency ?? null, input.retryMin ?? null, pos);
    this.sync();
    return this.get(input.slug)!;
  }

  update(slug: string, patch: Partial<{ label: string; baseUrl: string; keyOptional: boolean; flavor: CompatFlavor; enabled: boolean; concurrency: number | null; retryMin: number | null }>): boolean {
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
    if (patch.retryMin !== undefined) this.db.prepare(`UPDATE providers SET retry_min = ? WHERE slug = ?`).run(patch.retryMin, slug);
    this.sync();
    return true;
  }

  /** Removes the provider and its models (its key lives in the vault under the slug; the caller drops that). */
  remove(slug: string): boolean {
    if (!this.get(slug)) return false;
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM provider_models WHERE provider = ?`).run(slug);
      this.db.prepare(`DELETE FROM providers WHERE slug = ?`).run(slug);
    })();
    this.sync();
    return true;
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
      const tags = ov.tags ?? rep.tags ?? [];
      return {
        id: formatModelId(r.provider, r.model_id),
        provider: r.provider,
        upstream: r.model_id,
        label: ov.label ?? rep.label ?? r.model_id,
        kind: ov.kind ?? rep.kind ?? 'chat',
        tags,
        description: ov.description ?? rep.description ?? '',
        supportsImages: ov.supportsImages ?? rep.supportsImages ?? false,
        // Thinking models spend output tokens on reasoning before the answer: Gemini always does, others say so with the tag.
        minOutputTokens: ov.minOutputTokens ?? rep.minOutputTokens ?? (provider.flavor === 'gemini' || tags.includes('reasoning') ? REASONING_OUTPUT_FLOOR : undefined),
        toolSchemaMode: ov.toolSchemaMode ?? rep.toolSchemaMode,
        contextLength: ov.contextLength ?? rep.contextLength,
        supportsEffort: ov.supportsEffort ?? rep.supportsEffort ?? false,
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
}
