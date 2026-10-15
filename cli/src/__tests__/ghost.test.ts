import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as Llm from '../llm-types.js';
import { buildApp, type BuiltApp } from '../server.js';
import {
  GhostRuleError, LATEST_SCHEMA_VERSION, MIGRATIONS, createConversation, createGazetaItem, createProject, getConversation, getProject,
  isGhostConversation, listConversations, openDb, runMigrations, schemaVersion, updateConversation,
} from '../db.js';
import { ModelCatalog, parseDiscoveredModel } from '../providers/catalog.js';
import { ProviderRouter } from '../providers/router.js';
import { getModelInfo } from '../providers/registry.js';
import { AgentManager, type AgentLimits } from '../agents.js';
import { ToolRegistry } from '../tool-registry.js';
import { WebApprovalGate } from '../web-approval.js';
import { SSEManager } from '../sse.js';
import { createRun } from '../runs.js';
import { setSlots } from '../slots.js';
import { generateDailySummary } from '../gazeta.js';
import { ghostConnectorNames, ghostModelProblem } from '../ghost.js';
import type { McpConnectionLike } from '../mcp-client.js';

const TOKEN = 't';

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────────

const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null };
const answer = (t: string, stop = 'end_turn', content: unknown[] = [{ type: 'text', text: t, citations: null }]) =>
  ({ id: 'm', container: null, content, model: 'm', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message', usage }) as unknown as Llm.Message;

function req(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function untilIdle(port: number, convId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const s = (await req(port, 'GET', `/api/conversations/${convId}/status`)).json;
    if (s.status !== 'running') return;
    await new Promise(r => setTimeout(r, 15));
  }
  throw new Error('turn did not finish');
}

const fakeConnector = (name: string, tools: string[]): McpConnectionLike => ({
  name,
  async listTools() { return tools.map(t => ({ name: t, description: t, inputSchema: { type: 'object' } })); },
  async callTool(t) { return { text: `${t} ok`, isError: false }; },
});

// ─── catalog: where a model runs ─────────────────────────────────────────────────────────────────

describe('model locality (catalog)', () => {
  it('reads `locality` from a gateway /models entry and ignores junk', () => {
    assert.equal(parseDiscoveredModel({ id: 'qwen', locality: 'local' })!.reported.locality, 'local');
    assert.equal(parseDiscoveredModel({ id: 'flash', locality: 'cloud' })!.reported.locality, 'cloud');
    assert.equal(parseDiscoveredModel({ id: 'x', locality: 'LOCAL' })!.reported.locality, undefined);
    assert.equal(parseDiscoveredModel({ id: 'x', locality: true })!.reported.locality, undefined);
    // Nothing is inferred from tags, names or URLs.
    assert.equal(parseDiscoveredModel({ id: 'llama-local', tags: ['local'] })!.reported.locality, undefined);
  });

  it('is fail-closed: a model nobody vouched for is not local; per-model words beat the provider flag only upwards from "unknown"', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const c = new ModelCatalog(db, {});
    c.create({ slug: 'lan', label: 'LAN', baseUrl: 'http://192.168.1.5:11434/v1', keyOptional: true });
    c.addManual('lan', 'plain');
    assert.equal(getModelInfo('@lan/plain').locality, undefined);
    assert.match(ghostModelProblem('@lan/plain') ?? '', /not marked as a local model/);
    assert.match(ghostModelProblem('@nope/unknown') ?? '', /not in the model list/);
    assert.match(ghostModelProblem('') ?? '', /needs a local model/);

    // The user says the whole provider runs on their hardware.
    c.update('lan', { local: true });
    assert.equal(getModelInfo('@lan/plain').locality, 'local');
    assert.equal(ghostModelProblem('@lan/plain'), null);

    // …but a model that reports itself as cloud stays cloud (a hub with mixed upstreams).
    c.addManual('lan', 'hosted', { locality: 'cloud' });
    assert.equal(getModelInfo('@lan/hosted').locality, 'cloud');
    assert.match(ghostModelProblem('@lan/hosted') ?? '', /not marked as a local model/);

    // The user's per-model override wins over what the provider reports.
    c.updateModel('@lan/hosted', { fields: { locality: 'local' } });
    assert.equal(getModelInfo('@lan/hosted').locality, 'local');
    c.updateModel('@lan/hosted', { fields: { locality: null } });
    assert.equal(getModelInfo('@lan/hosted').locality, 'cloud');
  });

  it('withdraws the provider-level "local" claim when its URL changes', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const c = new ModelCatalog(db, {});
    c.create({ slug: 'lan', label: 'LAN', baseUrl: 'http://10.0.0.2:11434/v1', keyOptional: true, local: true });
    c.addManual('lan', 'm');
    assert.equal(getModelInfo('@lan/m').locality, 'local');
    c.update('lan', { baseUrl: 'https://api.example.com/v1' });
    assert.equal(c.get('lan')!.local, false);
    assert.equal(getModelInfo('@lan/m').locality, undefined);
    // Confirming it in the same edit keeps it.
    c.update('lan', { baseUrl: 'http://10.0.0.9:11434/v1', local: true });
    assert.equal(getModelInfo('@lan/m').locality, 'local');
    // Renaming the label alone does not touch it.
    c.update('lan', { label: 'Home' });
    assert.equal(c.get('lan')!.local, true);
  });
});

// ─── database: flag, triggers, migrations ────────────────────────────────────────────────────────

describe('ghost flag in the database', () => {
  it('cannot be flipped by any UPDATE, in either direction', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const ghost = createConversation(db, { ghost: true }).id;
    const plain = createConversation(db, {}).id;
    assert.throws(() => db.prepare(`UPDATE conversations SET ghost = 0 WHERE id = ?`).run(ghost), /ghost_immutable/);
    assert.throws(() => db.prepare(`UPDATE conversations SET ghost = 1 WHERE id = ?`).run(plain), /ghost_immutable/);
    const p = createProject(db, { name: 'secret', ghost: true });
    assert.throws(() => db.prepare(`UPDATE projects SET ghost = 0 WHERE id = ?`).run(p.id), /ghost_immutable/);
    // Writing the same value (or touching other columns) is fine.
    db.prepare(`UPDATE conversations SET ghost = 1, title = 'x' WHERE id = ?`).run(ghost);
    assert.equal(getConversation(db, ghost)!.title, 'x');
  });

  it('a chat in a ghost project is a ghost chat; ghost chats and projects keep their place', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const gp = createProject(db, { name: 'vault', ghost: true });
    const np = createProject(db, { name: 'normal' });
    const inGhost = createConversation(db, { projectId: gp.id }).id;
    assert.equal(getConversation(db, inGhost)!.ghost, true);
    assert.equal(isGhostConversation(db, inGhost), true);
    assert.equal(listConversations(db).find(c => c.id === inGhost)!.ghost, true);

    const loose = createConversation(db, { ghost: true }).id;
    const normal = createConversation(db, { projectId: np.id }).id;
    assert.throws(() => updateConversation(db, loose, { projectId: np.id }), (e: unknown) => e instanceof GhostRuleError && e.code === 'ghost_move');
    assert.throws(() => updateConversation(db, inGhost, { projectId: null }), (e: unknown) => e instanceof GhostRuleError && e.code === 'ghost_move');
    assert.throws(() => updateConversation(db, normal, { projectId: gp.id }), (e: unknown) => e instanceof GhostRuleError && e.code === 'ghost_move');
    // Ordinary moves between normal places still work, and a no-op "move" is not an error.
    const np2 = createProject(db, { name: 'other' });
    assert.equal(updateConversation(db, normal, { projectId: np2.id }), true);
    assert.equal(updateConversation(db, loose, { projectId: null, title: 'renamed' }), true);
    assert.equal(getProject(db, gp.id)!.ghost, true);
  });

  it('marks inbox items from ghost chats, keeps them out of the digest', async () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const ghost = createConversation(db, { ghost: true }).id;
    const plain = createConversation(db, {}).id;
    createGazetaItem(db, { type: 'report', conversationId: ghost, title: 'secret plan', description: 'launch codes', urgent: true });
    createGazetaItem(db, { type: 'report', conversationId: plain, title: 'groceries', description: 'milk' });

    const prompts: string[] = [];
    const llm = { messages: { async create(p: Llm.MessageCreateParamsNonStreaming) { prompts.push(JSON.stringify(p.messages)); return answer('digest'); } } };
    await generateDailySummary(db, llm as never, '@x/m');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /groceries/);
    assert.doesNotMatch(prompts[0]!, /secret plan|launch codes/);
  });
});

describe('versioned migrations', () => {
  it('stamps user_version, is idempotent and refuses a database from a newer build', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
    assert.equal(LATEST_SCHEMA_VERSION, MIGRATIONS[MIGRATIONS.length - 1]!.id);
    runMigrations(db); // second start: nothing to do, no error
    assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    assert.throws(() => runMigrations(db), /newer than this build/);
  });

  it('numbers are unique and ascending', () => {
    const ids = MIGRATIONS.map(m => m.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.equal(new Set(ids).size, ids.length);
  });

  it('upgrades a database that predates the ghost columns, keeping its data', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    // Simulate an old database: drop the triggers and columns' version stamp, keep the rows.
    db.exec(`DROP TRIGGER conversations_ghost_immutable; DROP TRIGGER projects_ghost_immutable;`);
    db.pragma('user_version = 0');
    const id = createConversation(db, { title: 'old chat' }).id;
    runMigrations(db);
    assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
    assert.equal(getConversation(db, id)!.title, 'old chat');
    assert.throws(() => db.prepare(`UPDATE conversations SET ghost = 1 WHERE id = ?`).run(id), /ghost_immutable/);
  });
});

describe('GHOST_CONNECTORS', () => {
  it('defaults to the operator infrastructure, can be emptied', () => {
    assert.deepEqual(ghostConnectorNames({}), ['sandbox', 'obsidian']);
    assert.deepEqual(ghostConnectorNames({ GHOST_CONNECTORS: ' sandbox , ' }), ['sandbox']);
    assert.deepEqual(ghostConnectorNames({ GHOST_CONNECTORS: '' }), []);
  });
});

// ─── HTTP API + a real turn ──────────────────────────────────────────────────────────────────────

describe('ghost chats over the API', () => {
  let built: BuiltApp;
  let server: http.Server;
  let port: number;
  let db: ReturnType<typeof openDb>;
  let router: ProviderRouter;
  let catalogBefore: ModelCatalog;
  const requests: Llm.MessageCreateParamsNonStreaming[] = [];
  const toolNames = (p: Llm.MessageCreateParamsNonStreaming) => ((p.tools ?? []) as Llm.Tool[]).map(t => t.name);

  before(async () => {
    db = openDb(':memory:');
    runMigrations(db);
    const client = {
      messages: {
        async create(p: Llm.MessageCreateParamsNonStreaming) {
          requests.push(p);
          // Title requests are tiny and say "title" in the system prompt; everything else is a normal reply.
          return JSON.stringify(p.system).includes('title') ? answer('A short title') : answer('Hello from the model');
        },
      },
    };
    router = new ProviderRouter({ db, env: {}, llmOverride: client as never });
    catalogBefore = router.catalog;
    router.catalog.create({ slug: 'home', label: 'Home node', baseUrl: 'http://192.168.1.10:11434/v1', keyOptional: true, local: true });
    router.catalog.addManual('home', 'qwen', { tags: ['free'] });
    router.catalog.addManual('home', 'llama');
    router.catalog.create({ slug: 'cloud', label: 'Cloud', baseUrl: 'https://cloud.example/v1', keyOptional: true });
    router.catalog.addManual('cloud', 'flash', { tags: ['free'] });
    router.catalog.addManual('cloud', 'big');
    setSlots(db, { helper: '@cloud/flash', chat: '@cloud/big' });
    const connections = [
      fakeConnector('sandbox', ['bash']),
      fakeConnector('obsidian', ['get_path']),
      fakeConnector('playwright', ['browser_open']),
      fakeConnector('github', ['create_issue']),
    ] as never;
    built = await buildApp({ db, connections, router, authToken: TOKEN, config: { model: '', autoApproveTools: ['get_path'] } });
    server = built.app.listen(0);
    await new Promise<void>(r => server.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  after(() => { built.stop(); server.close(); db.close(); });

  it('starts a ghost chat on a local model: the default is not used when it is cloud', async () => {
    const r = await req(port, 'POST', '/api/conversations', { ghost: true });
    assert.equal(r.status, 201);
    assert.equal(r.json.ghost, true);
    const conv = (await req(port, 'GET', `/api/conversations/${r.json.id}`)).json;
    assert.equal(conv.ghost, true);
    assert.match(conv.model, /^@home\//);
    assert.equal(conv.effectiveModel, conv.model);
  });

  it('refuses a cloud model at creation, with a stable code', async () => {
    const r = await req(port, 'POST', '/api/conversations', { ghost: true, model: '@cloud/flash' });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'ghost_requires_local_model');
    assert.match(r.json.error, /only uses local models/);
  });

  it('cannot be switched on or off afterwards, and can only change to another local model', async () => {
    const g = (await req(port, 'POST', '/api/conversations', { ghost: true, model: '@home/qwen' })).json.id as string;
    const n = (await req(port, 'POST', '/api/conversations', { model: '@cloud/big' })).json.id as string;

    let r = await req(port, 'PATCH', `/api/conversations/${g}`, { ghost: false });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'ghost_immutable');
    r = await req(port, 'PATCH', `/api/conversations/${n}`, { ghost: true });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'ghost_immutable');
    assert.equal((await req(port, 'GET', `/api/conversations/${n}`)).json.ghost, false);

    r = await req(port, 'PATCH', `/api/conversations/${g}`, { model: '@cloud/flash' });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'ghost_requires_local_model');
    r = await req(port, 'PATCH', `/api/conversations/${g}`, { model: '@home/llama', ghost: true, title: 'ok' });
    assert.equal(r.status, 200);
    assert.equal((await req(port, 'GET', `/api/conversations/${g}`)).json.model, '@home/llama');
  });

  it('ghost projects: chats inherit the flag, nothing moves in or out, the project cannot change', async () => {
    const p = (await req(port, 'POST', '/api/projects', { name: 'Vault', ghost: true })).json;
    assert.equal(p.ghost, true);
    const c = await req(port, 'POST', '/api/conversations', { projectId: p.id }); // no ghost flag, no model
    assert.equal(c.status, 201);
    assert.equal(c.json.ghost, true);
    assert.match((await req(port, 'GET', `/api/conversations/${c.json.id}`)).json.model, /^@home\//);
    assert.equal((await req(port, 'POST', '/api/conversations', { projectId: p.id, model: '@cloud/big' })).status, 400);

    let r = await req(port, 'PATCH', `/api/projects/${p.id}`, { ghost: false });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'ghost_immutable');
    const np = (await req(port, 'POST', '/api/projects', { name: 'Normal' })).json;
    assert.equal((await req(port, 'PATCH', `/api/projects/${np.id}`, { ghost: true })).json.code, 'ghost_immutable');
    assert.equal((await req(port, 'PATCH', `/api/projects/${np.id}`, { name: 'Renamed', ghost: false })).status, 200);

    const stray = (await req(port, 'POST', '/api/conversations', { model: '@cloud/big' })).json.id as string;
    r = await req(port, 'PATCH', `/api/conversations/${stray}`, { projectId: p.id });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'ghost_move');
    r = await req(port, 'PATCH', `/api/conversations/${c.json.id}`, { projectId: null });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'ghost_move');

    const list = (await req(port, 'GET', '/api/projects')).json.projects as Array<{ id: string; ghost: boolean }>;
    assert.equal(list.find(x => x.id === p.id)!.ghost, true);
  });

  it('a ghost turn talks only to local models, has no web/browser/third-party tools and no cloud helper', async () => {
    const id = (await req(port, 'POST', '/api/conversations', { ghost: true, model: '@home/qwen' })).json.id as string;
    requests.length = 0;
    const r = await req(port, 'POST', `/api/conversations/${id}/message`, { content: 'my private notes' });
    assert.equal(r.status, 200);
    await untilIdle(port, id);
    await new Promise(res => setTimeout(res, 50)); // let any detached title job finish
    assert.ok(requests.length >= 1);
    for (const q of requests) assert.match(String(q.model), /^@home\//, `a request went to ${String(q.model)}`);

    const chatCall = requests.find(q => toolNames(q).length > 0)!;
    const names = toolNames(chatCall);
    assert.ok(names.includes('sandbox__bash'), 'operator sandbox stays available');
    assert.ok(names.includes('obsidian__get_path'));
    assert.ok(!names.some(n => n.startsWith('playwright__') || n.startsWith('github__')), `third-party connector tools leaked: ${names.join(',')}`);
    assert.ok(!names.some(n => n === 'web_fetch' || n === 'web_search'), 'web tools must not be offered');
    assert.match(JSON.stringify(chatCall.system), /ghost chat/);
  });

  it('the same app does use the cloud helper and the web tools in a normal chat (the control)', async () => {
    const id = (await req(port, 'POST', '/api/conversations', { model: '@cloud/big' })).json.id as string;
    requests.length = 0;
    await req(port, 'POST', `/api/conversations/${id}/message`, { content: 'hello there' });
    await untilIdle(port, id);
    await new Promise(res => setTimeout(res, 50));
    assert.ok(requests.some(q => String(q.model) === '@cloud/flash'), 'title job should run on the free cloud helper');
    const chatCall = requests.find(q => String(q.model) === '@cloud/big')!;
    const names = toolNames(chatCall);
    assert.ok(names.includes('playwright__browser_open'));
    assert.ok(names.includes('web_fetch'));
  });

  it('a local helper in a ghost chat may write its title', async () => {
    setSlots(db, { helper: '@home/qwen' });
    try {
      const id = (await req(port, 'POST', '/api/conversations', { ghost: true, model: '@home/llama' })).json.id as string;
      requests.length = 0;
      await req(port, 'POST', `/api/conversations/${id}/message`, { content: 'some words for a title' });
      await untilIdle(port, id);
      await new Promise(res => setTimeout(res, 80));
      assert.ok(requests.length >= 2, 'chat call + title call');
      for (const q of requests) assert.match(String(q.model), /^@home\//);
      assert.equal((await req(port, 'GET', `/api/conversations/${id}`)).json.title, 'A short title');
    } finally {
      setSlots(db, { helper: '@cloud/flash' });
    }
  });

  it('refuses every turn endpoint, before storing anything, when the model stopped being local', async () => {
    const id = (await req(port, 'POST', '/api/conversations', { ghost: true, model: '@home/qwen' })).json.id as string;
    await req(port, 'POST', `/api/conversations/${id}/message`, { content: 'first' });
    await untilIdle(port, id);
    const before = (await req(port, 'GET', `/api/conversations/${id}/messages`)).json.messages.length as number;

    // The provider is pointed at a public URL: the "local" claim is withdrawn with it.
    catalogBefore.update('home', { baseUrl: 'https://api.elsewhere.example/v1' });
    try {
      requests.length = 0;
      for (const [path, body] of [
        [`/api/conversations/${id}/message`, { content: 'second' }],
        [`/api/conversations/${id}/edit`, { parentId: null, content: 'edited' }],
        [`/api/conversations/${id}/regenerate`, {}],
        [`/api/conversations/${id}/retry`, {}],
        [`/api/conversations/${id}/compact`, {}],
      ] as const) {
        const r = await req(port, 'POST', path, body);
        assert.equal(r.status, 409, path);
        assert.equal(r.json.code, 'ghost_requires_local_model', path);
      }
      assert.equal(requests.length, 0, 'nothing was sent anywhere');
      assert.equal((await req(port, 'GET', `/api/conversations/${id}/messages`)).json.messages.length, before, 'the refused message was not stored');
    } finally {
      catalogBefore.update('home', { baseUrl: 'http://192.168.1.10:11434/v1', local: true });
    }
  });

  it('exposes `local` on providers and `locality` on models so Settings can show and edit them', async () => {
    const providers = (await req(port, 'GET', '/api/providers')).json.providers as Array<{ id: string; local: boolean }>;
    assert.equal(providers.find(p => p.id === 'home')!.local, true);
    assert.equal(providers.find(p => p.id === 'cloud')!.local, false);
    const models = (await req(port, 'GET', '/api/models')).json.models as Array<{ id: string; locality?: string }>;
    assert.equal(models.find(m => m.id === '@home/qwen')!.locality, 'local');
    assert.equal(models.find(m => m.id === '@cloud/big')!.locality, undefined);

    assert.equal((await req(port, 'PATCH', '/api/providers/cloud', { local: true })).status, 200);
    assert.equal(((await req(port, 'GET', '/api/models')).json.models as Array<{ id: string; locality?: string }>).find(m => m.id === '@cloud/big')!.locality, 'local');
    await req(port, 'PATCH', '/api/providers/cloud', { local: false });
    assert.equal((await req(port, 'PATCH', '/api/models', { id: '@cloud/big', locality: 'local' })).status, 200);
    assert.equal(((await req(port, 'GET', '/api/providers/cloud/models')).json.models as Array<{ id: string; locality?: string }>).find(m => m.id === '@cloud/big')!.locality, 'local');
    await req(port, 'PATCH', '/api/models', { id: '@cloud/big', locality: null });
  });
});

// ─── worker agents ───────────────────────────────────────────────────────────────────────────────

describe('worker agents in a ghost chat', () => {
  const LIMITS: AgentLimits = { maxDepth: 2, maxSpawnsPerTree: 5, maxSteps: 10, softBudgetTokens: 1e9, hardBudgetTokens: 2e9, providerConcurrency: {}, defaultConcurrency: 3 };

  async function setup() {
    const db = openDb(':memory:');
    runMigrations(db);
    const requests: Llm.MessageCreateParamsNonStreaming[] = [];
    const client = { messages: { async create(p: Llm.MessageCreateParamsNonStreaming) { requests.push(p); return answer('report: done'); } } };
    const registry = new ToolRegistry(['x']);
    await registry.loadFrom([fakeConnector('sandbox', ['x']), fakeConnector('playwright', ['browser_open'])]);
    const router = new ProviderRouter({ db, env: {}, llmOverride: client as never });
    router.catalog.create({ slug: 'home', label: 'Home', baseUrl: 'http://10.0.0.2/v1', keyOptional: true, local: true });
    router.catalog.addManual('home', 'small', { tags: ['free'] });
    router.catalog.addManual('home', 'medium', { tags: ['free', 'coder'] });
    router.catalog.create({ slug: 'cloud', label: 'Cloud', baseUrl: 'https://cloud.example/v1', keyOptional: true });
    router.catalog.addManual('cloud', 'flash', { tags: ['free'] });
    router.catalog.addManual('cloud', 'big', { tags: ['reasoning', 'coder'] });
    const agents = new AgentManager({ db, router, registry, approval: new WebApprovalGate(db), sse: new SSEManager(), limits: LIMITS, recordUsage: () => {}, ghostConnectors: ['sandbox'] });
    const mk = (ghost: boolean) => {
      const conv = createConversation(db, { ghost, model: '@home/small' }).id;
      const root = createRun(db, { conversationId: conv, model: '@home/small', goal: 'orchestrate', label: 'assistant' });
      agents.registerRoot(root.id, new AbortController());
      return { conv, root };
    };
    return { db, agents, mk, requests };
  }

  it('workers must be local: explicit cloud ids, cloud tags and a cloud agents-slot are all refused or skipped', async () => {
    const { db, agents, mk } = await setup();
    const { root } = mk(true);
    const tool = agents.agentTools(root.id, new AbortController().signal).find(t => t.definition.name === 'spawn_agent')!;
    const call = async (input: Record<string, unknown>) => (await tool.handler({ goal: 'g', ...input }, { toolUseId: 'u1', conversationId: undefined, signal: new AbortController().signal })) as { text: string; isError?: boolean };

    let r = await call({ model: '@cloud/big' });
    assert.equal(r.isError, true);
    assert.match(r.text, /not a local model/);
    r = await call({ tag: 'reasoning' }); // only a cloud model carries this tag
    assert.equal(r.isError, true);
    assert.match(r.text, /no usable model is tagged/);

    setSlots(db, { subagent: '@cloud/flash' });
    r = await call({});
    assert.equal(r.isError, undefined);
    assert.match(r.text, /Spawned .* on @home\//, r.text); // the cloud slot was skipped, a local model took the job

    r = await call({ model: '@home/medium' });
    assert.equal(r.isError, undefined, r.text);
  });

  it('spawn() itself refuses a cloud model even when called directly; a normal chat is unaffected', async () => {
    const { agents, mk } = await setup();
    const ghost = mk(true);
    const direct = agents.spawn(ghost.root.id, { goal: 'x', model: '@cloud/big' });
    assert.ok('error' in direct && /not marked as a local model/.test(direct.error));

    const normal = mk(false);
    const ok = agents.spawn(normal.root.id, { goal: 'x', model: '@cloud/big' });
    assert.ok('runId' in ok);
  });

  it('a ghost worker sees only the ghost connectors and its transcript is a ghost conversation', async () => {
    const { db, agents, mk, requests } = await setup();
    const { root } = mk(true);
    const spawned = agents.spawn(root.id, { goal: 'look around', model: '@home/medium', tools: ['sandbox__x', 'playwright__browser_open'] });
    assert.ok('error' in spawned && /not available to the parent/.test(spawned.error), 'cannot even delegate a tool outside the ghost set');

    const ok = agents.spawn(root.id, { goal: 'look around', model: '@home/medium', tools: ['sandbox__x'] });
    assert.ok('runId' in ok);
    await new Promise(r => setTimeout(r, 100));
    const workerCall = requests.find(q => JSON.stringify(q.system).includes('worker agent'))!;
    // Only the control tools every agent has (spawn_agent, …) besides the one delegated connector tool.
    assert.deepEqual(((workerCall.tools ?? []) as Llm.Tool[]).map(t => t.name).filter(n => n.includes('__')), ['sandbox__x']);
    const run = (db.prepare(`SELECT transcript_conversation_id AS t FROM runs WHERE depth = 1 ORDER BY rowid DESC LIMIT 1`).get() as { t: string } | undefined)?.t;
    if (run) assert.equal(isGhostConversation(db, run), true);
  });
});
