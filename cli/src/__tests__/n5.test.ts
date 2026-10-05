import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Anthropic from '@anthropic-ai/sdk';
import { openDb, runMigrations } from '../db.js';
import { ProviderRouter } from '../providers/router.js';
import { KeyVault } from '../providers/key-vault.js';
import { getModelInfo, setCustomProviders } from '../providers/registry.js';
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
  const upstream: Array<{ url: string; body: any; auth: string | null }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    upstream.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers['Authorization'] ?? null });
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'llama-4', name: 'Llama 4' }] }), { status: 200 });
    return new Response(JSON.stringify({
      id: 'x', model: 'llama-4', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi from custom' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const router = new ProviderRouter({ db, vault: new KeyVault(db, 'k'.repeat(40)), env: {}, fetchImpl });
  const registry = new ToolRegistry([]);
  const connections: McpConnectionLike[] = [];
  const closed: string[] = [];
  const n5 = createN5Routes({
    db, router, registry, connections, fetchImpl,
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
  return { db, router, registry, connections, closed, upstream, port, close: () => { server.closeAllConnections(); server.close(); setCustomProviders([]); } };
}

describe('N5 custom providers', () => {
  it('create → models appear in the catalog → chat routes to the custom base URL with the upstream model id and key', async () => {
    const t = await setup();
    try {
      assert.equal((await call(t.port, 'POST', '/api/custom-providers', { slug: 'Bad Slug', baseUrl: 'https://x' })).status, 400);
      assert.equal((await call(t.port, 'POST', '/api/custom-providers', { slug: 'or', baseUrl: 'https://user:pw@x' })).status, 400);
      const created = await call(t.port, 'POST', '/api/custom-providers', {
        slug: 'or', label: 'OpenRouter', baseUrl: 'https://openrouter.example/api/v1/', apiKey: 'sk-or-secret',
        models: [{ id: 'llama-4', label: 'Llama 4', pricing: { input: 0.2, output: 0.6 } }, { id: 'bad id' }],
      });
      assert.equal(created.status, 201);

      const info = getModelInfo('@or/llama-4');
      assert.equal(info.provider, 'custom:or');
      assert.deepEqual(info.pricing, { input: 0.2, output: 0.6, cacheWrite: 0.2, cacheRead: 0.02 });
      const models = t.router.models().filter(m => m.provider === 'custom:or');
      assert.deepEqual(models.map(m => [m.id, m.available]), [['@or/llama-4', true]]);

      const { client } = t.router.clientFor('@or/llama-4');
      const reply = await client.messages.create({ model: '@or/llama-4', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] } as Anthropic.MessageCreateParamsNonStreaming);
      assert.equal((reply.content[0] as { text: string }).text, 'hi from custom');
      const req = t.upstream.at(-1)!;
      assert.equal(req.url, 'https://openrouter.example/api/v1/chat/completions');
      assert.equal(req.body.model, 'llama-4');
      assert.equal(req.auth, 'Bearer sk-or-secret');

      const discovered = await call(t.port, 'POST', '/api/custom-providers/or/discover');
      assert.deepEqual(discovered.json.models, [{ id: 'llama-4', label: 'Llama 4' }]);

      const list = await call(t.port, 'GET', '/api/custom-providers');
      assert.equal(list.json.providers[0].hasKey, true);
      assert.equal(JSON.stringify(list.json).includes('sk-or-secret'), false, 'keys never leave the server');

      await call(t.port, 'DELETE', '/api/custom-providers/or');
      assert.throws(() => t.router.clientFor('@or/llama-4'));
    } finally { t.close(); }
  });

  it('keyless local providers work without a key and send no Authorization header', async () => {
    const t = await setup();
    try {
      await call(t.port, 'POST', '/api/custom-providers', { slug: 'lmstudio', baseUrl: 'http://192.168.1.20:1234/v1', keyOptional: true, models: [{ id: 'qwen' }] });
      const { client } = t.router.clientFor('@lmstudio/qwen');
      await client.messages.create({ model: '@lmstudio/qwen', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] } as Anthropic.MessageCreateParamsNonStreaming);
      assert.equal(t.upstream.at(-1)!.auth, null);
    } finally { t.close(); }
  });
});

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
