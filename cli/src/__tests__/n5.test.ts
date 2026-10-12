import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, runMigrations } from '../db.js';
import { ProviderRouter } from '../providers/router.js';
import { KeyVault } from '../providers/key-vault.js';
import { ToolRegistry } from '../tool-registry.js';
import { createN5Routes, migrateN5 } from '../n5-routes.js';
import type { McpConnectionLike } from '../mcp-client.js';

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

async function setup() {
  const db = openDb(':memory:');
  runMigrations(db);
  migrateN5(db);
  const router = new ProviderRouter({ db, vault: new KeyVault(db, 'k'.repeat(40)), env: {} });
  const registry = new ToolRegistry([]);
  const connections: McpConnectionLike[] = [];
  const closed: string[] = [];
  const n5 = createN5Routes({
    db, router, registry, connections,
    connect: async cfg => {
      if (cfg.url.includes('down')) throw new Error('connection refused');
      return {
        name: cfg.name,
        async listTools() { return [{ name: 'ping', description: `auth=${cfg.apiKey ?? 'none'}`, inputSchema: { type: 'object' } }]; },
        async callTool() { return { text: 'pong', isError: false }; },
        async close() { closed.push(cfg.name); },
      };
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api', n5.api);
  const server = app.listen(0);
  await new Promise<void>(r => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { db, router, registry, connections, closed, port, close: () => { server.closeAllConnections(); server.close(); } };
}

describe('N5 connectors', () => {
  it('add (token from the vault) → tools registered; failures are reported; disable/delete remove the tools', async () => {
    const t = await setup();
    try {
      assert.equal((await call(t.port, 'POST', '/api/custom-connectors', { name: 'Bad', url: 'https://x' })).status, 400);
      assert.equal((await call(t.port, 'POST', '/api/custom-connectors', { name: 'n8n', url: 'file:///etc' })).status, 400);
      const ok = await call(t.port, 'POST', '/api/custom-connectors', { name: 'n8n', url: 'https://n8n.example/mcp', token: 'tok123' });
      assert.equal(ok.status, 201);
      assert.equal(ok.json.error, null);
      const tools = t.registry.toAnthropicTools();
      assert.deepEqual(tools.map(x => [x.name, x.description]), [['n8n__ping', 'auth=tok123']]);

      const bad = await call(t.port, 'POST', '/api/custom-connectors', { name: 'broken', url: 'https://down.example/mcp' });
      assert.match(bad.json.error, /refused/);
      const list = (await call(t.port, 'GET', '/api/custom-connectors')).json.connectors;
      assert.deepEqual(list.map((c: any) => [c.name, c.connected, c.toolCount, c.hasToken]), [['n8n', true, 1, true], ['broken', false, 0, false]]);

      await call(t.port, 'POST', '/api/custom-connectors/n8n/disable');
      assert.equal(t.registry.toAnthropicTools().length, 0);
      assert.deepEqual(t.closed, ['n8n']);
      await call(t.port, 'POST', '/api/custom-connectors/n8n/reconnect');
      assert.equal(t.registry.toAnthropicTools().length, 1);
      await call(t.port, 'DELETE', '/api/custom-connectors/n8n');
      assert.equal(t.connections.length, 0);
      assert.equal(t.router.vault.hasKey('connector:n8n').present, false);
    } finally { t.close(); }
  });
});
