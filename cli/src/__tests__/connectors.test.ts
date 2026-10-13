import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, runMigrations } from '../db.js';
import { ProviderRouter } from '../providers/router.js';
import { KeyVault } from '../providers/key-vault.js';
import { ToolRegistry } from '../tool-registry.js';
import { createConnectorRoutes, isLocalHost, migrateConnectors, suggestConnectorName, validateConnectorUrl } from '../connector-routes.js';
import { isSessionLost, type McpConnectionLike } from '../mcp-client.js';

function call(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json' } }, res => {
      const c: Buffer[] = [];
      res.on('data', d => c.push(d));
      res.on('end', () => { const t = Buffer.concat(c).toString(); resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} }); });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function setup(env: McpConnectionLike[] = []) {
  const db = openDb(':memory:');
  runMigrations(db);
  migrateConnectors(db);
  const router = new ProviderRouter({ db, vault: new KeyVault(db, 'k'.repeat(40)), env: {} });
  const registry = new ToolRegistry([]);
  const connections: McpConnectionLike[] = [...env];
  await registry.loadFrom(connections);
  const closed: string[] = [];
  const attempts: Array<{ name: string; url: string; apiKey?: string }> = [];
  const routes = createConnectorRoutes({
    db, router, registry, connections,
    connect: async cfg => {
      attempts.push(cfg);
      if (cfg.url.includes('down')) throw new Error('connection refused');
      return {
        name: cfg.name,
        trusted: false,
        serverName: 'Ping Server',
        async listTools() { return [{ name: 'ping', description: `auth=${cfg.apiKey ?? 'none'}`, inputSchema: { type: 'object' } }]; },
        async callTool() { return { text: 'pong', isError: false }; },
        async close() { closed.push(cfg.name); },
      };
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api', routes.api);
  const server = app.listen(0);
  await new Promise<void>(r => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { db, router, registry, connections, closed, attempts, routes, port, close: () => { server.closeAllConnections(); server.close(); } };
}

describe('connector URL rules', () => {
  it('accepts https anywhere and plain http only for local and private hosts, never credentials in the URL', () => {
    assert.deepEqual(validateConnectorUrl(' https://mcp.example.com/mcp/ '), { url: 'https://mcp.example.com/mcp' });
    for (const ok of ['http://localhost:3000/mcp', 'http://192.168.1.10/mcp', 'http://10.0.0.2:8/x', 'http://172.20.0.3/m', 'http://100.101.1.1/m', 'http://sandbox-mcp:3002/mcp', 'http://nas.local/mcp', 'http://[::1]:9/m']) {
      assert.ok('url' in validateConnectorUrl(ok), ok);
    }
    for (const bad of ['http://mcp.example.com/mcp', 'http://172.32.0.1/x', 'http://8.8.8.8/x', 'ftp://x/y', 'file:///etc/passwd', 'not a url', '', 'https://user:pw@host/mcp', undefined, 5]) {
      assert.ok('error' in validateConnectorUrl(bad), String(bad));
    }
    assert.equal(isLocalHost('example.com'), false);
    assert.equal(isLocalHost('172.15.0.1'), false);
  });

  it('derives a valid, unique name from the address', () => {
    const none = new Set<string>();
    assert.equal(suggestConnectorName('https://mcp.notion.com/mcp', none), 'notion');
    assert.equal(suggestConnectorName('https://obsidian.futumore.pl/mcp/sse', none), 'obsidian');
    assert.equal(suggestConnectorName('http://192.168.1.10:3000/mcp', none), 'c_192_168_1_10');
    assert.equal(suggestConnectorName('https://api.example.com/mcp', new Set(['example', 'example_2'])), 'example_3');
    assert.match(suggestConnectorName('https://-.x/', none), /^[a-z][a-z0-9_]{0,31}$/);
  });

  it('retries a call only when the server never saw it', () => {
    assert.equal(isSessionLost(new Error('Session not found')), true);
    assert.equal(isSessionLost(new Error('Streamable HTTP error: HTTP 404: Not Found')), true);
    assert.equal(isSessionLost(Object.assign(new Error('fetch failed'), { cause: new Error('connect ECONNREFUSED 10.0.0.1:80') })), true);
    assert.equal(isSessionLost(new Error('fetch failed')), false, 'a connection cut mid-call may have run');
    assert.equal(isSessionLost(new Error('Request timed out')), false);
  });
});

describe('connectors API', () => {
  it('add (name from the URL, token from the vault) → tools registered and untrusted; failures are reported; disable/delete remove the tools', async () => {
    const t = await setup();
    try {
      assert.equal((await call(t.port, 'POST', '/api/connectors', { name: 'Bad', url: 'https://x.example' })).status, 400);
      assert.equal((await call(t.port, 'POST', '/api/connectors', { url: 'file:///etc' })).status, 400);
      assert.equal((await call(t.port, 'POST', '/api/connectors', { url: 'http://evil.example/mcp' })).status, 400);

      const ok = await call(t.port, 'POST', '/api/connectors', { url: 'https://n8n.example.com/mcp', token: 'tok123' });
      assert.equal(ok.status, 201);
      assert.equal(ok.json.name, 'n8n');
      assert.equal(ok.json.error, null);
      assert.deepEqual([ok.json.connector.source, ok.json.connector.connected, ok.json.connector.hasToken, ok.json.connector.toolCount], ['custom', true, true, 1]);
      assert.deepEqual(t.registry.toLlmTools().map(x => [x.name, x.description]), [['n8n__ping', 'auth=tok123']]);
      assert.equal(t.registry.requiresApproval('n8n__ping'), true);

      assert.equal((await call(t.port, 'POST', '/api/connectors', { name: 'n8n', url: 'https://other.example/mcp' })).status, 409);
      const second = await call(t.port, 'POST', '/api/connectors', { url: 'https://n8n.other.org/mcp' });
      assert.equal(second.json.name, 'n8n_2', 'same host label gets a suffix');

      const bad = await call(t.port, 'POST', '/api/connectors', { name: 'broken', url: 'https://down.example/mcp' });
      assert.match(bad.json.error, /refused/);
      const list = (await call(t.port, 'GET', '/api/connectors')).json.connectors;
      assert.deepEqual(list.map((c: any) => [c.name, c.connected, c.toolCount, c.hasToken]), [['n8n', true, 1, true], ['n8n_2', true, 1, false], ['broken', false, 0, false]]);
      assert.match(list[2].error, /refused/);
      assert.deepEqual(list[0].tools, [{ name: 'ping', description: 'auth=tok123' }]);

      await call(t.port, 'POST', '/api/connectors/n8n/disable');
      assert.equal(t.registry.toolsOf('n8n').length, 0);
      assert.deepEqual(t.closed, ['n8n']);
      const afterDisable = (await call(t.port, 'GET', '/api/connectors')).json.connectors.find((c: any) => c.name === 'n8n');
      assert.deepEqual([afterDisable.enabled, afterDisable.connected], [false, false]);
      await call(t.port, 'POST', '/api/connectors/n8n/reconnect');
      assert.equal(t.registry.toolsOf('n8n').length, 1);
      await call(t.port, 'DELETE', '/api/connectors/n8n');
      assert.equal(t.connections.some(c => c.name === 'n8n'), false);
      assert.equal(t.router.vault.hasKey('connector:n8n').present, false);
      assert.equal((await call(t.port, 'DELETE', '/api/connectors/nope')).status, 404);
    } finally { t.close(); }
  });

  it('edit changes the URL and the token (set, keep, clear) and reconnects', async () => {
    const t = await setup();
    try {
      await call(t.port, 'POST', '/api/connectors', { name: 'svc', url: 'https://one.example/mcp', token: 'a' });
      const keep = await call(t.port, 'PATCH', '/api/connectors/svc', { url: 'https://two.example/mcp' });
      assert.equal(keep.json.connector.url, 'https://two.example/mcp');
      assert.equal(t.attempts[t.attempts.length - 1]!.apiKey, 'a', 'token untouched when not sent');
      await call(t.port, 'PATCH', '/api/connectors/svc', { token: 'b' });
      assert.equal(t.attempts[t.attempts.length - 1]!.apiKey, 'b');
      const cleared = await call(t.port, 'PATCH', '/api/connectors/svc', { token: null });
      assert.equal(cleared.json.connector.hasToken, false);
      assert.equal(t.attempts[t.attempts.length - 1]!.apiKey, undefined);
      assert.equal((await call(t.port, 'PATCH', '/api/connectors/svc', { url: 'ftp://x' })).status, 400);
      assert.equal((await call(t.port, 'PATCH', '/api/connectors/ghost', { url: 'https://x.example' })).status, 404);
      assert.equal(t.connections.length, 1, 'no duplicate connection after edits');
      const broken = await call(t.port, 'PATCH', '/api/connectors/svc', { url: 'https://down.example/mcp' });
      assert.match(broken.json.error, /refused/);
      assert.equal(broken.json.connector.connected, false);
    } finally { t.close(); }
  });

  it('test lists the tools without saving or leaving a connection open', async () => {
    const t = await setup();
    try {
      const ok = await call(t.port, 'POST', '/api/connectors/test', { url: 'https://x.example/mcp', token: 'tt' });
      assert.deepEqual([ok.json.ok, ok.json.serverName, ok.json.tools], [true, 'Ping Server', [{ name: 'ping', description: 'auth=tt' }]]);
      assert.deepEqual(t.closed, ['test']);
      assert.equal((await call(t.port, 'GET', '/api/connectors')).json.connectors.length, 0);
      assert.deepEqual((await call(t.port, 'POST', '/api/connectors/test', { url: 'https://down.example/m' })).json, { ok: false, error: 'connection refused' });
      assert.equal((await call(t.port, 'POST', '/api/connectors/test', { url: 'gopher://x' })).status, 400);
    } finally { t.close(); }
  });

  it('lists operator-configured connectors too (read-only, reconnectable) and a down one does not hide the rest', async () => {
    let up = false;
    const env: McpConnectionLike = {
      name: 'sandbox', url: 'http://sandbox-mcp:3002/mcp?key=secret', trusted: true,
      get connected() { return up; }, lastError: 'ECONNREFUSED',
      async connect() { up = true; },
      async listTools() { return [{ name: 'read_log', description: 'log', inputSchema: { type: 'object' } }]; },
      async callTool() { return { text: '', isError: false }; },
    } as McpConnectionLike;
    const t = await setup([env]);
    try {
      const before = (await call(t.port, 'GET', '/api/connectors')).json.connectors[0];
      assert.deepEqual([before.name, before.source, before.connected, before.error, before.url], ['sandbox', 'env', false, 'ECONNREFUSED', 'http://sandbox-mcp:3002/mcp']);
      assert.equal(before.hasToken, undefined);
      assert.equal((await call(t.port, 'PATCH', '/api/connectors/sandbox', { url: 'https://x.example' })).status, 404, 'env connectors are not editable here');
      assert.equal((await call(t.port, 'DELETE', '/api/connectors/sandbox')).status, 404);

      const r = await call(t.port, 'POST', '/api/connectors/sandbox/reconnect');
      assert.equal(r.json.connector.connected, true);
      assert.deepEqual(t.registry.toLlmTools().map(x => x.name), ['sandbox__read_log']);
      assert.equal((await call(t.port, 'POST', '/api/connectors/ghost/reconnect')).status, 404);
    } finally { t.close(); }
  });

  it('saved connectors come back at startup; one that fails does not stop the others', async () => {
    const t = await setup();
    try {
      t.db.prepare(`INSERT INTO custom_connectors (name, url) VALUES ('good', 'https://good.example/mcp'), ('down', 'https://down.example/mcp'), ('off', 'https://off.example/mcp')`).run();
      t.db.prepare(`UPDATE custom_connectors SET enabled = 0 WHERE name = 'off'`).run();
      await t.routes.startSaved();
      const list = (await call(t.port, 'GET', '/api/connectors')).json.connectors;
      assert.deepEqual(list.map((c: any) => [c.name, c.connected, c.enabled]), [['good', true, true], ['down', false, true], ['off', false, false]]);
    } finally { t.close(); }
  });
});
