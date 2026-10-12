import express from 'express';
import type Database from 'better-sqlite3';
import type { ProviderRouter } from './providers/router.js';
import { McpConnection, type McpConnectionLike } from './mcp-client.js';
import type { ToolRegistry } from './tool-registry.js';
import type { KeyVault } from './providers/key-vault.js';

/**
 * N5 — Settings: remote MCP connectors managed from the UI. (Custom model providers used to live here; they are
 * now ordinary providers, see providers/catalog.ts.) Tokens live in the key vault (rows `connector:<name>`); only
 * metadata is in plain tables. Connectors are remote HTTP(S) MCP servers only — nothing is spawned on the host.
 */

const CONNECTOR_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

export function migrateN5(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_connectors (
      name        TEXT PRIMARY KEY,
      url         TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
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

export interface N5Deps {
  db: Database.Database;
  router: ProviderRouter;
  registry: ToolRegistry;
  /** The live MCP connection list (startup env connectors + UI ones) — /api/connectors reads it. */
  connections: McpConnectionLike[];
  /** For tests: build a connection without a network. */
  connect?: (cfg: { name: string; url: string; apiKey?: string }) => Promise<McpConnectionLike & { close?: () => Promise<void> }>;
}

export function createN5Routes(deps: N5Deps) {
  const { db, router, registry, connections } = deps;
  const vault: KeyVault = router.vault;
  const connectorErrors = new Map<string, string>();

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
