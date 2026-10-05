import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { AgentManager, type AgentLimits } from '../agents.js';
import { runTurn } from '../anthropic-loop.js';
import { ToolRegistry } from '../tool-registry.js';
import { WebApprovalGate } from '../web-approval.js';
import { SSEManager } from '../sse.js';
import { openDb, runMigrations, createConversation } from '../db.js';
import {
  createRun, getRun, listRuns, treeUsage, interruptOrphanedRuns, postRunMessage, drainRunMessages, addRunUsage, setRunStatus,
} from '../runs.js';
import type { McpConnectionLike } from '../mcp-client.js';
import type { ProviderRouter } from '../providers/router.js';

const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null };
const message = (content: unknown[], stop: string) =>
  ({ id: 'm', container: null, content, model: 'm', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message', usage }) as unknown as Anthropic.Message;
const text = (t: string) => ({ type: 'text', text: t, citations: null });
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input });
const tick = () => new Promise(r => setTimeout(r, 5));

const LIMITS: AgentLimits = {
  maxDepth: 2, maxSpawnsPerTree: 5, maxSteps: 10, softBudgetUsd: 100, hardBudgetUsd: 200, hardBudgetTokens: 1e9,
  providerConcurrency: {}, defaultConcurrency: 3,
};

type Script = (p: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message | Promise<Anthropic.Message>;

async function setup(script: Script, opts: { limits?: Partial<AgentLimits>; autoApprove?: string[]; cost?: number } = {}) {
  const db = openDb(':memory:');
  runMigrations(db);
  const conv = createConversation(db, { title: 'chat' }).id;
  const executed: string[] = [];
  const conn: McpConnectionLike = {
    name: 'srv',
    async listTools() {
      return [
        { name: 'x', description: 'x', inputSchema: { type: 'object' } },
        { name: 'y', description: 'y', inputSchema: { type: 'object' } },
      ];
    },
    async callTool(name) { executed.push(name); return { text: `${name} ok`, isError: false }; },
  };
  const registry = new ToolRegistry(opts.autoApprove ?? ['x', 'y']);
  await registry.loadFrom([conn]);
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let active = 0;
  let maxActive = 0;
  const client = {
    messages: {
      async create(p: Anthropic.MessageCreateParamsNonStreaming) {
        requests.push(p);
        active++; maxActive = Math.max(maxActive, active);
        try { await tick(); return await script(p); } finally { active--; }
      },
    },
  };
  const router = { clientFor: () => ({ provider: 'anthropic', info: {}, client }), redact: (m: string) => m } as unknown as ProviderRouter;
  const gate = new WebApprovalGate(db);
  const agents = new AgentManager({
    db, router, registry, approval: gate, sse: new SSEManager(),
    limits: { ...LIMITS, ...opts.limits },
    recordUsage: () => opts.cost ?? 0,
  });
  const root = createRun(db, { conversationId: conv, model: 'm', goal: 'orchestrate', label: 'assistant' });
  const controller = new AbortController();
  agents.registerRoot(root.id, controller);
  return { db, conv, agents, root, controller, requests, executed, gate, maxActive: () => maxActive };
}

const isWorker = (p: Anthropic.MessageCreateParamsNonStreaming) => JSON.stringify(p.system).includes('worker agent');
const toolNames = (p: Anthropic.MessageCreateParamsNonStreaming) => ((p.tools ?? []) as Anthropic.Tool[]).map(t => t.name);

describe('runs table', () => {
  it('tracks trees, usage, mailbox and interrupts orphans at startup', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const root = createRun(db, { model: 'm', goal: 'g' });
    assert.equal(root.rootRunId, root.id);
    const child = createRun(db, { parentRunId: root.id, rootRunId: root.id, model: 'm', goal: 'c', depth: 1 });
    addRunUsage(db, root.id, { inputTokens: 1, outputTokens: 2, costUsd: 0.5 });
    addRunUsage(db, child.id, { inputTokens: 3, outputTokens: 4, costUsd: 0.25 });
    assert.deepEqual(treeUsage(db, root.id), { inputTokens: 4, outputTokens: 6, costUsd: 0.75 });

    postRunMessage(db, { runId: child.id, fromRunId: root.id, fromLabel: 'boss', body: 'hi' });
    assert.deepEqual(drainRunMessages(db, child.id).map(m => m.body), ['hi']);
    assert.equal(drainRunMessages(db, child.id).length, 0);

    setRunStatus(db, root.id, 'done');
    assert.equal(interruptOrphanedRuns(db), 1);
    assert.equal(getRun(db, child.id)!.status, 'interrupted');
    assert.equal(getRun(db, root.id)!.status, 'done');
  });
});

describe('runTurn inbox', () => {
  it('delivers drained messages into the latest user turn at a step boundary', async () => {
    const seen: Anthropic.MessageParam[][] = [];
    let n = 0;
    const inbox = [['[message from a]\nfirst'], [], []];
    await runTurn(
      {
        anthropic: { messages: { async create(p: Anthropic.MessageCreateParamsNonStreaming) { seen.push(structuredClone(p.messages)); return n++ === 0 ? message([toolUse('t1', 'v')], 'tool_use') : message([text('ok')], 'end_turn'); } } },
        model: 'm', tools: new ToolRegistry([]), systemPrompt: 's', confirm: async () => true,
        virtualTools: [{ definition: { name: 'v', description: 'v', input_schema: { type: 'object' } }, handler: async () => ({ text: 'done' }) }],
        drainInbox: () => inbox.shift() ?? [],
      },
      [],
      'go',
    );
    const firstUser = seen[0]!.at(-1)!;
    assert.deepEqual((firstUser.content as Array<{ text: string }>).map(b => b.text), ['go', '[message from a]\nfirst']);
    // Second request: the tool_result turn is untouched (nothing new in the inbox).
    assert.equal((seen[1]!.at(-1)!.content as Array<{ type: string }>)[0]!.type, 'tool_result');
  });
});

describe('AgentManager', () => {
  it('spawn returns immediately; wait collects the worker report; worker tools are only what was delegated', async () => {
    const t = await setup(p => (isWorker(p) ? message([text('report: all good')], 'end_turn') : message([text('?')], 'end_turn')));
    const r = t.agents.spawn(t.root.id, { goal: 'check x', model: 'm', tools: ['srv/x'], label: 'checker' });
    assert.ok('runId' in r);
    const { runs, timedOut } = await t.agents.wait([r.runId], 'all');
    assert.equal(timedOut, false);
    assert.equal(runs[0]!.status, 'done');
    assert.equal(runs[0]!.result, 'report: all good');
    assert.equal(runs[0]!.label, 'checker');
    const workerReq = t.requests.find(isWorker)!;
    // srv/x normalized to the exposed name; agent tools present; depth 1 < maxDepth 2 so spawn_agent too.
    assert.ok(toolNames(workerReq).includes('srv__x'));
    assert.ok(!toolNames(workerReq).includes('srv__y'));
    assert.ok(toolNames(workerReq).includes('spawn_agent'));
    // The parent got a "finished" notice in its inbox.
    assert.match(drainRunMessages(t.db, t.root.id)[0]!.body, /checker.*finished/s);
  });

  it('narrowing only: a worker cannot delegate tools it does not have; depth and spawn limits apply', async () => {
    const t = await setup(() => message([text('done')], 'end_turn'), { limits: { maxDepth: 1, maxSpawnsPerTree: 2 } });
    const a = t.agents.spawn(t.root.id, { goal: 'a', model: 'm', tools: ['srv__x'] });
    assert.ok('runId' in a);
    const grand = t.agents.spawn(a.runId, { goal: 'b', model: 'm', tools: ['srv__y'] });
    assert.ok('error' in grand && /depth/.test(grand.error));
    await t.agents.wait([a.runId], 'all');
    const leafReq = t.requests.find(isWorker)!;
    assert.ok(!toolNames(leafReq).includes('spawn_agent'), 'leaf workers do not see spawn_agent');

    const t2 = await setup(() => message([text('done')], 'end_turn'), { limits: { maxSpawnsPerTree: 1 } });
    const w = t2.agents.spawn(t2.root.id, { goal: 'a', model: 'm', tools: ['srv__x'] });
    assert.ok('runId' in w);
    const outside = t2.agents.spawn(w.runId, { goal: 'b', model: 'm', tools: ['srv__y'] });
    assert.ok('error' in outside);
    const second = t2.agents.spawn(t2.root.id, { goal: 'c', model: 'm' });
    assert.ok('error' in second && /spawn limit/.test(second.error));
    await t2.agents.wait([w.runId], 'all');
  });

  it('stopping the root (kill switch) stops the worker tree, including a worker parked on an approval', async () => {
    const t = await setup(p => (isWorker(p) ? message([toolUse('t1', 'srv__x')], 'tool_use') : message([text('?')], 'end_turn')), { autoApprove: [] });
    const r = t.agents.spawn(t.root.id, { goal: 'needs approval', model: 'm', tools: ['srv__x'] });
    assert.ok('runId' in r);
    for (let i = 0; i < 50 && t.gate.listPending().length === 0; i++) await tick();
    const pending = t.gate.listPending();
    assert.equal(pending.length, 1);
    assert.match(pending[0]!.toolLabel, /^\[agent agent-1\] srv\/x$/);
    assert.equal(getRun(t.db, r.runId)!.status, 'waiting_input');
    t.controller.abort();
    const { runs } = await t.agents.wait([r.runId], 'all');
    assert.equal(runs[0]!.status, 'aborted');
    assert.deepEqual(t.executed, []);
  });

  it('hard budget stops the workers of the tree', async () => {
    let calls = 0;
    const t = await setup(p => {
      if (!isWorker(p)) return message([text('?')], 'end_turn');
      calls++;
      return message([toolUse(`t${calls}`, 'srv__x')], 'tool_use'); // never finishes on its own
    }, { cost: 1, limits: { hardBudgetUsd: 2.5, softBudgetUsd: 1 } });
    const r = t.agents.spawn(t.root.id, { goal: 'loop', model: 'm', tools: ['srv__x'] });
    assert.ok('runId' in r);
    const { runs } = await t.agents.wait([r.runId], 'all');
    assert.equal(runs[0]!.status, 'aborted');
    assert.match(runs[0]!.error!, /budget/);
    assert.ok(calls <= 3, `stopped promptly (calls=${calls})`);
    // Soft warning reached the root's inbox.
    assert.ok(drainRunMessages(t.db, t.root.id).some(m => /budget/.test(m.body)));
    assert.ok('error' in t.agents.spawn(t.root.id, { goal: 'more', model: 'm' }));
  });

  it('queues model calls per provider', async () => {
    const t = await setup(p => (isWorker(p) ? message([text('done')], 'end_turn') : message([text('?')], 'end_turn')), { limits: { defaultConcurrency: 1 } });
    const ids = [1, 2, 3].map(i => t.agents.spawn(t.root.id, { goal: `g${i}`, model: 'm' })).map(r => ('runId' in r ? r.runId : ''));
    await t.agents.wait(ids, 'all');
    assert.equal(t.maxActive(), 1);
    assert.equal(listRuns(t.db, { rootRunId: t.root.id }).filter(r => r.status === 'done').length, 3);
  });

  it('agent tools: send_message reaches the worker inbox, list/get/stop stay inside the tree', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const t = await setup(async p => {
      if (!isWorker(p)) return message([text('?')], 'end_turn');
      await gate;
      return message([text('done')], 'end_turn');
    });
    const tools = new Map(t.agents.agentTools(t.root.id, t.controller.signal).map(v => [v.definition.name, v]));
    const ctx = { toolUseId: 'x' };
    const spawned = await tools.get('spawn_agent')!.handler({ goal: 'g', model: 'm', label: 'w' }, ctx);
    const runId = /Spawned (\w+)/.exec(spawned.text)![1]!;
    assert.match((await tools.get('send_message')!.handler({ to: runId, body: 'use v2' }, ctx)).text, /Delivered/);
    assert.match((await tools.get('list_agents')!.handler({}, ctx)).text, /1 agent/);
    const other = createRun(t.db, { model: 'm', goal: 'unrelated' });
    assert.equal((await tools.get('get_run')!.handler({ run_id: other.id }, ctx)).isError, true);
    assert.equal((await tools.get('stop_agent')!.handler({ run_id: other.id }, ctx)).isError, true);
    release();
    const waited = await tools.get('wait_agents')!.handler({ run_ids: [runId] }, ctx);
    assert.match(waited.text, /\[done\]/);
  });
});
