import express from 'express';
import type Database from 'better-sqlite3';
import type { ProviderRouter } from './providers/router.js';
import { setCustomProviders, type CustomModelDef, type CustomProviderDef } from './providers/registry.js';
import { McpConnection, type McpConnectionLike } from './mcp-client.js';
import type { ToolRegistry } from './tool-registry.js';
import type { KeyVault } from './providers/key-vault.js';

/**
 * N5 — Settings: custom OpenAI-compatible providers and remote MCP connectors managed from the UI.
 * Keys/tokens live in the key vault (rows `custom:<slug>` and `connector:<name>`); only metadata is in
 * plain tables. Connectors are remote HTTP(S) MCP servers only — nothing is spawned on the host.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CONNECTOR_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

export function migrateN5(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_providers (
      slug        TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      base_url    TEXT NOT NULL,
      key_optional INTEGER NOT NULL DEFAULT 0,
      models      TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS custom_connectors (
      name        TEXT PRIMARY KEY,
      url         TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function loadCustomProviders(db: Database.Database): CustomProviderDef[] {
  return (db.prepare(`SELECT * FROM custom_providers ORDER BY created_at`).all() as Record<string, unknown>[]).map(r => ({
    slug: r['slug'] as string,
    label: r['label'] as string,
    baseUrl: r['base_url'] as string,
    keyOptional: r['key_optional'] === 1,
    models: JSON.parse(r['models'] as string) as CustomModelDef[],
  }));
}

function validHttpUrl(raw: unknown): string | null {
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

function sanitizeModels(raw: unknown): CustomModelDef[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomModelDef[] = [];
  for (const m of raw.slice(0, 200)) {
    if (!m || typeof m !== 'object') continue;
    const o = m as Record<string, unknown>;
    const id = typeof o['id'] === 'string' ? o['id'].trim() : '';
    if (!id || id.length > 200 || /\s/.test(id)) continue;
    const p = o['pricing'] as Record<string, unknown> | null | undefined;
    out.push({
      id,
      label: typeof o['label'] === 'string' ? o['label'].slice(0, 100) : undefined,
      supportsImages: o['supportsImages'] === true,
      toolSchemaMode: o['toolSchemaMode'] === 'flat' || o['toolSchemaMode'] === 'none' ? o['toolSchemaMode'] : 'full',
      pricing: p && typeof p['input'] === 'number' && typeof p['output'] === 'number' ? { input: p['input'], output: p['output'] } : null,
    });
  }
  return out;
}

export interface N5Deps {
  db: Database.Database;
  router: ProviderRouter;
  registry: ToolRegistry;
  /** The live MCP connection list (startup env connectors + UI ones) — /api/connectors reads it. */
  connections: McpConnectionLike[];
  /** For tests: build a connection without a network. */
  connect?: (cfg: { name: string; url: string; apiKey?: string }) => Promise<McpConnectionLike & { close?: () => Promise<void> }>;
  fetchImpl?: typeof fetch;
}

export function createN5Routes(deps: N5Deps) {
  const { db, router, registry, connections } = deps;
  const vault: KeyVault = router.vault;
  const doFetch = deps.fetchImpl ?? fetch;
  const connectorErrors = new Map<string, string>();
  const refreshProviders = () => setCustomProviders(loadCustomProviders(db));
  refreshProviders();

  const connect = deps.connect ?? (async (cfg: { name: string; url: string; apiKey?: string }) => {
    const c = new McpConnection({ name: cfg.name, url: cfg.url, apiKey: cfg.apiKey });
    await c.connect();
    return c;
  });

  async function startConnector(name: string, url: string): Promise<void> {
    const key = vault.read(`connector:${name}`);
    try {
      const conn = await connect({ name, url, apiKey: key.status === 'ok' ? key.key : undefined });
      await registry.loadFrom([conn]);
      connections.push(conn);
      connectorErrors.delete(name);
    } catch (err) {
      connectorErrors.set(name, (err as Error).message.slice(0, 300));
    }
  }

  async function stopConnector(name: string): Promise<void> {
    registry.removeConnection(name);
    const i = connections.findIndex(c => c.name === name);
    if (i >= 0) {
      const [conn] = connections.splice(i, 1);
      await (conn as { close?: () => Promise<void> }).close?.().catch(() => {});
    }
  }

  /** Connect every saved, enabled connector (startup). Failures are reported in the UI, not fatal. */
  async function startSaved(): Promise<void> {
    const rows = db.prepare(`SELECT name, url FROM custom_connectors WHERE enabled = 1`).all() as Array<{ name: string; url: string }>;
    await Promise.all(rows.map(r => startConnector(r.name, r.url)));
  }

  const api = express.Router();

  // ─── Custom providers ──────────────────────────────────────────────────
  api.get('/custom-providers', (_req, res) => {
    res.json({
      providers: loadCustomProviders(db).map(p => ({ ...p, hasKey: vault.hasKey(`custom:${p.slug}`).present, last4: vault.hasKey(`custom:${p.slug}`).last4 })),
    });
  });

  api.post('/custom-providers', (req, res) => {
    const { slug, label, baseUrl, keyOptional, models, apiKey } = (req.body ?? {}) as Record<string, unknown>;
    const url = validHttpUrl(baseUrl);
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) { res.status(400).json({ error: 'slug: lowercase letters, digits and dashes (max 32)' }); return; }
    if (!url) { res.status(400).json({ error: 'baseUrl must be an http(s) URL without credentials, e.g. https://openrouter.ai/api/v1' }); return; }
    try {
      db.prepare(`INSERT INTO custom_providers (slug, label, base_url, key_optional, models) VALUES (?, ?, ?, ?, ?)`)
        .run(slug, typeof label === 'string' && label.trim() ? label.trim().slice(0, 60) : slug, url, keyOptional === true ? 1 : 0, JSON.stringify(sanitizeModels(models)));
    } catch {
      res.status(409).json({ error: 'a provider with this slug already exists' });
      return;
    }
    if (typeof apiKey === 'string' && apiKey.trim()) {
      try { router.saveKey(`custom:${slug}`, apiKey.trim()); } catch (err) { res.status(400).json({ error: (err as Error).message }); return; }
    }
    refreshProviders();
    res.status(201).json({ ok: true });
  });

  api.patch('/custom-providers/:slug', (req, res) => {
    const { label, baseUrl, keyOptional, models } = (req.body ?? {}) as Record<string, unknown>;
    const url = baseUrl === undefined ? undefined : validHttpUrl(baseUrl);
    if (url === null) { res.status(400).json({ error: 'invalid baseUrl' }); return; }
    const r = db.prepare(`
      UPDATE custom_providers SET
        label = COALESCE(?, label), base_url = COALESCE(?, base_url),
        key_optional = COALESCE(?, key_optional), models = COALESCE(?, models)
      WHERE slug = ?`).run(
      typeof label === 'string' && label.trim() ? label.trim().slice(0, 60) : null,
      url ?? null,
      typeof keyOptional === 'boolean' ? (keyOptional ? 1 : 0) : null,
      models !== undefined ? JSON.stringify(sanitizeModels(models)) : null,
      req.params.slug,
    );
    if (!r.changes) { res.status(404).json({ error: 'not found' }); return; }
    refreshProviders();
    res.json({ ok: true });
  });

  api.put('/custom-providers/:slug/key', (req, res) => {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (!apiKey) { res.status(400).json({ error: 'apiKey required' }); return; }
    if (!loadCustomProviders(db).some(p => p.slug === req.params.slug)) { res.status(404).json({ error: 'not found' }); return; }
    try { res.json(router.saveKey(`custom:${req.params.slug}`, apiKey)); } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  api.delete('/custom-providers/:slug', (req, res) => {
    const r = db.prepare(`DELETE FROM custom_providers WHERE slug = ?`).run(req.params.slug);
    if (!r.changes) { res.status(404).json({ error: 'not found' }); return; }
    router.removeKey(`custom:${req.params.slug}`);
    refreshProviders();
    res.json({ ok: true });
  });

  /** Lists the upstream's models (GET {base}/models) so the user can pick instead of typing ids. */
  api.post('/custom-providers/:slug/discover', async (req, res) => {
    const p = loadCustomProviders(db).find(x => x.slug === req.params.slug);
    if (!p) { res.status(404).json({ error: 'not found' }); return; }
    const key = vault.read(`custom:${p.slug}`);
    try {
      const r = await doFetch(`${p.baseUrl}/models`, { headers: key.status === 'ok' ? { Authorization: `Bearer ${key.key}` } : {} });
      if (!r.ok) { res.status(502).json({ error: router.redact(`upstream returned ${r.status}: ${(await r.text()).slice(0, 200)}`) }); return; }
      const json = (await r.json()) as { data?: Array<{ id?: string; name?: string }> };
      res.json({ models: (json.data ?? []).filter(m => typeof m.id === 'string').slice(0, 500).map(m => ({ id: m.id!, label: m.name })) });
    } catch (err) {
      res.status(502).json({ error: router.redact((err as Error).message) });
    }
  });

  api.post('/custom-providers/:slug/test', async (req, res) => {
    res.json(await router.test(`custom:${req.params.slug}`));
  });

  // ─── Connectors (remote MCP over HTTP) ─────────────────────────────────
  api.get('/custom-connectors', (_req, res) => {
    const rows = db.prepare(`SELECT * FROM custom_connectors ORDER BY created_at`).all() as Array<{ name: string; url: string; enabled: number }>;
    res.json({
      connectors: rows.map(r => ({
        name: r.name,
        url: r.url,
        enabled: r.enabled === 1,
        connected: connections.some(c => c.name === r.name),
        error: connectorErrors.get(r.name) ?? null,
        hasToken: vault.hasKey(`connector:${r.name}`).present,
        toolCount: registry.toAnthropicTools().filter(t => t.name.startsWith(`${r.name}__`)).length,
      })),
    });
  });

  api.post('/custom-connectors', async (req, res) => {
    const { name, url, token } = (req.body ?? {}) as Record<string, unknown>;
    const u = validHttpUrl(url);
    if (typeof name !== 'string' || !CONNECTOR_NAME_RE.test(name)) { res.status(400).json({ error: 'name: lowercase letters, digits, _ (starts with a letter, max 32)' }); return; }
    if (!u) { res.status(400).json({ error: 'url must be an http(s) MCP endpoint (Streamable HTTP)' }); return; }
    if (connections.some(c => c.name === name)) { res.status(409).json({ error: 'a connector with this name is already active' }); return; }
    try {
      db.prepare(`INSERT INTO custom_connectors (name, url) VALUES (?, ?)`).run(name, u);
    } catch {
      res.status(409).json({ error: 'a connector with this name already exists' });
      return;
    }
    if (typeof token === 'string' && token.trim()) {
      try { vault.set(`connector:${name}`, token.trim()); } catch (err) { res.status(400).json({ error: (err as Error).message }); return; }
    }
    await startConnector(name, u);
    res.status(201).json({ ok: true, error: connectorErrors.get(name) ?? null });
  });

  api.post('/custom-connectors/:name/reconnect', async (req, res) => {
    const row = db.prepare(`SELECT url FROM custom_connectors WHERE name = ?`).get(req.params.name) as { url: string } | undefined;
    if (!row) { res.status(404).json({ error: 'not found' }); return; }
    await stopConnector(req.params.name);
    db.prepare(`UPDATE custom_connectors SET enabled = 1 WHERE name = ?`).run(req.params.name);
    await startConnector(req.params.name, row.url);
    res.json({ ok: true, error: connectorErrors.get(req.params.name) ?? null });
  });

  api.post('/custom-connectors/:name/disable', async (req, res) => {
    const r = db.prepare(`UPDATE custom_connectors SET enabled = 0 WHERE name = ?`).run(req.params.name);
    if (!r.changes) { res.status(404).json({ error: 'not found' }); return; }
    await stopConnector(req.params.name);
    res.json({ ok: true });
  });

  api.delete('/custom-connectors/:name', async (req, res) => {
    const r = db.prepare(`DELETE FROM custom_connectors WHERE name = ?`).run(req.params.name);
    if (!r.changes) { res.status(404).json({ error: 'not found' }); return; }
    await stopConnector(req.params.name);
    vault.delete(`connector:${req.params.name}`);
    connectorErrors.delete(req.params.name);
    res.json({ ok: true });
  });

  return { api, startSaved };
}
