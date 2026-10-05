import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { runSubagent } from '../subagent.js';
import { ToolRegistry } from '../tool-registry.js';
import { WebApprovalGate } from '../web-approval.js';
import { SSEManager } from '../sse.js';
import { openDb, runMigrations, createConversation, listConversations, getMessages } from '../db.js';
import type { McpConnectionLike } from '../mcp-client.js';
import type { ProviderRouter } from '../providers/router.js';
function freshDb() {
  const db = openDb(':memory:');
  runMigrations(db);
  return db;
}

const usage = { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null };
const message = (content: unknown[], stop: string) =>
  ({ id: 'm', container: null, content, model: 'm', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message', usage }) as unknown as Anthropic.Message;
const text = (t: string) => ({ type: 'text', text: t, citations: null });
const toolUse = (id: string, name: string) => ({ type: 'tool_use', id, name, input: { a: 1 } });

function setup(autoApprove: string[] = []) {
  const db = openDb(':memory:');
  runMigrations(db);
  const parent = createConversation(db, { title: 'parent' }).id;
  const executed: string[] = [];
  const conn: McpConnectionLike = {
    name: 'srv',
    async listTools() {
      return [
        { name: 'x', description: 'x', inputSchema: { type: 'object' } },
        { name: 'y', description: 'y', inputSchema: { type: 'object' } },
      ];
    },
    async callTool(name) {
      executed.push(name);
      return { text: `${name} ok`, isError: false };
    },
  };
  const registry = new ToolRegistry(autoApprove);
  const gate = new WebApprovalGate(freshDb());
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const makeRouter = (script: (n: number) => Anthropic.Message): ProviderRouter => {
    let n = 0;
    const client = { messages: { async create(p: Anthropic.MessageCreateParamsNonStreaming) { requests.push(p); return script(n++); } } };
    return { clientFor: () => ({ provider: 'anthropic', info: {}, client }), redact: (m: string) => m } as unknown as ProviderRouter;
  };
  return { db, parent, registry, gate, executed, requests, makeRouter, conn, sse: new SSEManager() };
}

describe('runSubagent', () => {
  it('allowlist is fail-closed: the model only sees the listed tools, and none when the list is empty/omitted', async () => {
    const t = setup(['x', 'y']);
    await t.registry.loadFrom([t.conn]);
    const router = t.makeRouter(() => message([text('done')], 'end_turn'));

    await runSubagent({ goal: 'g', model: 'm', allowedTools: ['srv__x'] }, { db: t.db, router, registry: t.registry, sse: t.sse, parentConvId: t.parent, approval: t.gate });
    await runSubagent({ goal: 'g', model: 'm', allowedTools: [] }, { db: t.db, router, registry: t.registry, sse: t.sse, parentConvId: t.parent, approval: t.gate });
    await runSubagent({ goal: 'g', model: 'm' }, { db: t.db, router, registry: t.registry, sse: t.sse, parentConvId: t.parent, approval: t.gate });

    const names = (r: Anthropic.MessageCreateParamsNonStreaming) => ((r.tools ?? []) as Anthropic.Tool[]).map(x => x.name);
    assert.deepEqual(names(t.requests[0]!), ['srv__x']);
    assert.deepEqual(names(t.requests[1]!), []);
    assert.deepEqual(names(t.requests[2]!), []);
  });

  it('cannot call a tool outside the allowlist even if the model names it anyway (auto-approved tools included)', async () => {
    const t = setup(['x', 'y']); // both would be auto-approved — the old code skipped the allowlist for these
    await t.registry.loadFrom([t.conn]);
    const router = t.makeRouter(n =>
      n === 0 ? message([toolUse('tu1', 'srv__y')], 'tool_use') : message([text('gave up')], 'end_turn'),
    );
    await runSubagent({ goal: 'g', model: 'm', allowedTools: ['srv__x'] }, { db: t.db, router, registry: t.registry, sse: t.sse, parentConvId: t.parent, approval: t.gate });
    assert.deepEqual(t.executed, []);
  });

  it('approvals use the shared gate: listed under the parent conversation, answerable, and the tool then runs', async () => {
    const t = setup(); // nothing auto-approved
    await t.registry.loadFrom([t.conn]);
    const router = t.makeRouter(n =>
      n === 0 ? message([toolUse('tu1', 'srv__x')], 'tool_use') : message([text('all done')], 'end_turn'),
    );
    const run = runSubagent({ goal: 'g', model: 'm', allowedTools: ['srv__x'] }, { db: t.db, router, registry: t.registry, sse: t.sse, parentConvId: t.parent, approval: t.gate });

    for (let i = 0; i < 100 && t.gate.listPending().length === 0; i++) await new Promise(r => setTimeout(r, 10));
    const pending = t.gate.listPending();
    assert.equal(pending.length, 1, 'the subagent approval must be visible to the UI');
    assert.equal(pending[0]!.conversationId, t.parent);
    assert.equal(pending[0]!.toolLabel, '[subagent] srv/x');
    t.gate.resolve(pending[0]!.id, true, 'once');

    const result = await run;
    assert.equal(result.status, 'done');
    assert.equal(result.summary, 'all done');
    assert.deepEqual(t.executed, ['x']);
  });

  it('kill switch rejects a parked subagent approval, clears it from the list, and never runs the tool', async () => {
    const t = setup();
    await t.registry.loadFrom([t.conn]);
    const router = t.makeRouter(() => message([toolUse('tu1', 'srv__x')], 'tool_use'));
    const controller = new AbortController();
    const run = runSubagent({ goal: 'g', model: 'm', allowedTools: ['srv__x'] }, { db: t.db, router, registry: t.registry, sse: t.sse, parentConvId: t.parent, approval: t.gate, signal: controller.signal });
    for (let i = 0; i < 100 && t.gate.listPending().length === 0; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(t.gate.listPending().length, 1);

    controller.abort();
    const result = await run;
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /abort/i);
    assert.equal(t.gate.listPending().length, 0);
    assert.deepEqual(t.executed, []);
  });

  it('reports usage for the ledger, hides its conversation from the sidebar, and stores the goal once', async () => {
    const t = setup();
    await t.registry.loadFrom([t.conn]);
    const router = t.makeRouter(() => message([text('summary')], 'end_turn'));
    const usages: unknown[] = [];
    const result = await runSubagent(
      { goal: 'find the thing', model: 'm' },
      { db: t.db, router, registry: t.registry, sse: t.sse, parentConvId: t.parent, approval: t.gate, onUsage: u => usages.push(u) },
    );
    assert.equal(usages.length, 1);
    assert.deepEqual(listConversations(t.db).map(c => c.title), ['parent']);

    const all = t.db.prepare(`SELECT id FROM conversations WHERE kind = 'subagent'`).all() as Array<{ id: string }>;
    assert.equal(all.length, 1);
    const msgs = getMessages(t.db, all[0]!.id);
    assert.equal(msgs.filter(m => m.role === 'user').length, 1, 'goal must not be duplicated in history');
    assert.equal(result.status, 'done');
  });

  it('fails a runaway loop at the step limit instead of spinning forever', async () => {
    const t = setup(['x']); // auto-approved so the loop never parks
    await t.registry.loadFrom([t.conn]);
    const router = t.makeRouter(n => message([toolUse(`tu${n}`, 'srv__x')], 'tool_use'));
    const result = await runSubagent({ goal: 'g', model: 'm', allowedTools: ['srv__x'] }, { db: t.db, router, registry: t.registry, sse: t.sse, parentConvId: t.parent, approval: t.gate });
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /step limit/);
    assert.ok(t.executed.length <= 30);
  });
});

describe('WebApprovalGate — abort signal', () => {
  it('resolves false and removes the pending entry when the signal aborts while waiting', async () => {
    const gate = new WebApprovalGate(freshDb());
    const c = new AbortController();
    const p = gate.confirm('conv', 'srv/x', {}, c.signal);
    assert.equal(gate.listPending().length, 1);
    c.abort();
    assert.equal(await p, false);
    assert.equal(gate.listPending().length, 0);
  });

  it('returns false immediately for an already-aborted signal', async () => {
    const gate = new WebApprovalGate(freshDb());
    const c = new AbortController();
    c.abort();
    assert.equal(await gate.confirm('conv', 'srv/x', {}, c.signal), false);
    assert.equal(gate.listPending().length, 0);
  });
});
