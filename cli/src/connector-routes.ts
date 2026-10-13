import express from 'express';
import type Database from 'better-sqlite3';
import type { ProviderRouter } from './providers/router.js';
import { McpConnection, type McpConnectionLike } from './mcp-client.js';
import type { ToolRegistry } from './tool-registry.js';
import type { KeyVault } from './providers/key-vault.js';

/**
 * Settings → Connectors: remote MCP servers added by URL, like in Claude. One list shows everything that is connected —
 * the connectors the operator configured through the environment (MCP_CONNECTORS: sandbox, browser, …; read-only here,
 * only reconnect) and the ones added from the UI (add, test, edit, disable, remove). Tokens live in the key vault (rows
 * `connector:<name>`); only metadata is in the plain table. Remote HTTP(S) servers only — nothing is spawned on the host.
 * Tools of UI-added connectors always ask for approval until the user grants them (see ToolRegistry.requiresApproval).
 */

const CONNECTOR_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

export function migrateConnectors(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_connectors (
      name        TEXT PRIMARY KEY,
      url         TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/** Hosts where plain http is acceptable: loopback, private ranges, Tailscale, `.local`/`.internal`/`.lan`, and single-label docker names. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || /^(fc|fd)[0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  return !h.includes('.') || /\.(local|internal|lan|home|localdomain)$/.test(h);
}

/** A clean endpoint URL, or an error sentence. No credentials in the URL (they go in the vault); plain http only on local hosts. */
export function validateConnectorUrl(raw: unknown): { url: string } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'url is required' };
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { error: 'that is not a valid URL' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'url must start with https:// (or http:// for a local server)' };
  if (u.username || u.password) return { error: 'do not put credentials in the URL — use the token field' };
  if (u.protocol === 'http:' && !isLocalHost(u.hostname)) return { error: 'plain http is only accepted for local or private addresses — use https://' };
  u.hash = '';
  return { url: u.toString().replace(/\/+$/, '') };
}

/** `https://mcp.notion.com/mcp` → `notion`. Always a valid connector name, unique among `taken`. */
export function suggestConnectorName(url: string, taken: ReadonlySet<string>): string {
  let host = 'connector';
  try { host = new URL(url).hostname; } catch { /* keep default */ }
  const labels = host.split('.').filter(l => l && !['www', 'mcp', 'api', 'app'].includes(l));
  // An address has no meaningful first label: keep all of it (127.0.0.1 → c_127_0_0_1).
  let base = (/^[\d.]+$/.test(host) ? labels.join('_') : (labels[0] ?? 'connector')).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(base)) base = `c_${base}`.replace(/_+$/, '');
  base = (base || 'connector').slice(0, 28);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  return name;
}

/** Same URL without credentials or query string — safe to show. */
function displayUrl(raw: string | undefined): string {
  if (!raw) return '';
  try { const u = new URL(raw); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString().replace(/\/+$/, ''); } catch { return raw; }
}

type Conn = McpConnectionLike & { close?: () => Promise<void> };

export interface ConnectorDeps {
  db: Database.Database;
  router: ProviderRouter;
  registry: ToolRegistry;
  /** The live MCP connection list (operator-configured at startup + UI-added) — also read by /health and shutdown. */
  connections: McpConnectionLike[];
  /** For tests: build a connection without a network. */
  connect?: (cfg: { name: string; url: string; apiKey?: string }) => Promise<Conn>;
}

interface Row { name: string; url: string; enabled: number }

export function createConnectorRoutes(deps: ConnectorDeps) {
  const { db, router, registry, connections } = deps;
  const vault: KeyVault = router.vault;
  const errors = new Map<string, string>();

  const connect = deps.connect ?? (async (cfg: { name: string; url: string; apiKey?: string }) => {
    const c = new McpConnection({ name: cfg.name, url: cfg.url, apiKey: cfg.apiKey }, false);
    await c.connect();
    return c;
  });

  const rows = () => db.prepare(`SELECT name, url, enabled FROM custom_connectors ORDER BY rowid`).all() as Row[];
  const rowOf = (name: string) => db.prepare(`SELECT name, url, enabled FROM custom_connectors WHERE name = ?`).get(name) as Row | undefined;
  const takenNames = () => new Set([...rows().map(r => r.name), ...connections.map(c => c.name)]);

  async function start(name: string, url: string): Promise<void> {
    const key = vault.read(`connector:${name}`);
    try {
      const conn = await connect({ name, url, apiKey: key.status === 'ok' ? key.key : undefined });
      const failed = await registry.loadFrom([conn]);
      if (failed.length) { await conn.close?.().catch(() => {}); throw new Error(`could not list tools: ${failed[0]!.error}`); }
      connections.push(conn);
      errors.delete(name);
    } catch (err) {
      errors.set(name, (err as Error).message.slice(0, 300));
    }
  }

  async function stop(name: string): Promise<void> {
    registry.removeConnection(name);
    const i = connections.findIndex(c => c.name === name);
    if (i >= 0) {
      const [conn] = connections.splice(i, 1);
      await (conn as Conn).close?.().catch(() => {});
    }
  }

  /** Connect every saved, enabled connector (startup). Failures are shown in the UI, never fatal. */
  async function startSaved(): Promise<void> {
    await Promise.all(rows().filter(r => r.enabled === 1).map(r => start(r.name, r.url)));
  }

  function info(name: string) {
    const row = rowOf(name);
    const live = connections.find(c => c.name === name);
    const tools = registry.toolsOf(name);
    const connected = live !== undefined && live.connected !== false;
    return {
      name,
      url: displayUrl(row?.url ?? live?.url),
      source: row ? ('custom' as const) : ('env' as const),
      enabled: row ? row.enabled === 1 : true,
      connected,
      error: connected ? null : (errors.get(name) ?? live?.lastError ?? null),
      hasToken: row ? vault.hasKey(`connector:${name}`).present : undefined,
      toolCount: tools.length,
      tools,
    };
  }

  function allNames(): string[] {
    const custom = rows().map(r => r.name);
    return [...connections.map(c => c.name).filter(n => !custom.includes(n)), ...custom];
  }

  const api = express.Router();
  const route = (fn: (req: express.Request, res: express.Response) => Promise<void> | void): express.RequestHandler =>
    (req, res) => { Promise.resolve(fn(req, res)).catch(err => { if (!res.headersSent) res.status(500).json({ error: (err as Error).message }); }); };

  api.get('/connectors', route((_req, res) => { res.json({ connectors: allNames().map(info) }); }));

  // Try a URL (and token) without saving anything: connects, lists the tools, disconnects.
  api.post('/connectors/test', route(async (req, res) => {
    const { url, token } = (req.body ?? {}) as Record<string, unknown>;
    const v = validateConnectorUrl(url);
    if ('error' in v) { res.status(400).json({ error: v.error }); return; }
    let conn: Conn | undefined;
    try {
      conn = await connect({ name: 'test', url: v.url, apiKey: typeof token === 'string' && token.trim() ? token.trim() : undefined });
      const tools = await conn.listTools();
      res.json({ ok: true, serverName: conn.serverName ?? null, tools: tools.map(t => ({ name: t.name, description: t.description })) });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message.slice(0, 300) });
    } finally {
      await conn?.close?.().catch(() => {});
    }
  }));

  api.post('/connectors', route(async (req, res) => {
    const { name: rawName, url, token } = (req.body ?? {}) as Record<string, unknown>;
    const v = validateConnectorUrl(url);
    if ('error' in v) { res.status(400).json({ error: v.error }); return; }
    let name: string;
    if (typeof rawName === 'string' && rawName.trim()) {
      name = rawName.trim();
      if (!CONNECTOR_NAME_RE.test(name)) { res.status(400).json({ error: 'name: lowercase letters, digits and _ (starts with a letter, max 32)' }); return; }
      if (takenNames().has(name)) { res.status(409).json({ error: 'a connector with this name already exists' }); return; }
    } else {
      name = suggestConnectorName(v.url, takenNames());
    }
    if (typeof token === 'string' && token.trim()) {
      try { vault.set(`connector:${name}`, token.trim()); } catch (err) { res.status(400).json({ error: (err as Error).message }); return; }
    }
    db.prepare(`INSERT INTO custom_connectors (name, url) VALUES (?, ?)`).run(name, v.url);
    await start(name, v.url);
    res.status(201).json({ ok: true, name, error: errors.get(name) ?? null, connector: info(name) });
  }));

  // Change URL and/or token (token: a string sets it, null or '' removes it). The connector reconnects with the new settings.
  api.patch('/connectors/:name', route(async (req, res) => {
    const name = String(req.params['name']);
    const row = rowOf(name);
    if (!row) { res.status(404).json({ error: 'not a connector added in Settings' }); return; }
    const { url, token } = (req.body ?? {}) as Record<string, unknown>;
    let nextUrl = row.url;
    if (url !== undefined) {
      const v = validateConnectorUrl(url);
      if ('error' in v) { res.status(400).json({ error: v.error }); return; }
      nextUrl = v.url;
    }
    if (typeof token === 'string' && token.trim()) {
      try { vault.set(`connector:${name}`, token.trim()); } catch (err) { res.status(400).json({ error: (err as Error).message }); return; }
    } else if (token === null || token === '') {
      vault.delete(`connector:${name}`);
    }
    db.prepare(`UPDATE custom_connectors SET url = ?, enabled = 1 WHERE name = ?`).run(nextUrl, name);
    await stop(name);
    await start(name, nextUrl);
    res.json({ ok: true, error: errors.get(name) ?? null, connector: info(name) });
  }));

  api.post('/connectors/:name/reconnect', route(async (req, res) => {
    const name = String(req.params['name']);
    const row = rowOf(name);
    if (row) {
      await stop(name);
      db.prepare(`UPDATE custom_connectors SET enabled = 1 WHERE name = ?`).run(name);
      await start(name, row.url);
      res.json({ ok: true, error: errors.get(name) ?? null, connector: info(name) });
      return;
    }
    const live = connections.find(c => c.name === name);
    if (!live?.connect) { res.status(404).json({ error: 'unknown connector' }); return; }
    try {
      await live.connect();
      const failed = await registry.loadFrom([live]);
      if (failed.length) throw new Error(failed[0]!.error);
      errors.delete(name);
    } catch (err) {
      errors.set(name, (err as Error).message.slice(0, 300));
    }
    res.json({ ok: true, error: errors.get(name) ?? null, connector: info(name) });
  }));

  api.post('/connectors/:name/disable', route(async (req, res) => {
    const name = String(req.params['name']);
    const r = db.prepare(`UPDATE custom_connectors SET enabled = 0 WHERE name = ?`).run(name);
    if (!r.changes) { res.status(404).json({ error: 'not a connector added in Settings' }); return; }
    await stop(name);
    errors.delete(name);
    res.json({ ok: true, connector: info(name) });
  }));

  api.delete('/connectors/:name', route(async (req, res) => {
    const name = String(req.params['name']);
    const r = db.prepare(`DELETE FROM custom_connectors WHERE name = ?`).run(name);
    if (!r.changes) { res.status(404).json({ error: 'not a connector added in Settings' }); return; }
    await stop(name);
    vault.delete(`connector:${name}`);
    errors.delete(name);
    res.json({ ok: true });
  }));

  return { api, startSaved };
}
