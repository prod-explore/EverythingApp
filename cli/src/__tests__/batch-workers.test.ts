import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { AgentManager, type AgentLimits } from '../agents.js';
import { createBatchedClient, type AnthropicBatchLike } from '../batch.js';
import { ToolRegistry } from '../tool-registry.js';
import { WebApprovalGate } from '../web-approval.js';
import { SSEManager } from '../sse.js';
import { openDb, runMigrations, createConversation } from '../db.js';
import { createRun, getRun } from '../runs.js';
import type { McpConnectionLike } from '../mcp-client.js';
import type { ProviderRouter } from '../providers/router.js';

const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null };
const message = (content: unknown[], stop: string) =>
  ({ id: 'm', container: null, content, model: 'm', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message', usage }) as unknown as Anthropic.Message;
const LIMITS: AgentLimits = { maxDepth: 2, maxSpawnsPerTree: 5, maxSteps: 10, softBudgetUsd: 100, hardBudgetUsd: 200, hardBudgetTokens: 1e9, providerConcurrency: {}, defaultConcurrency: 3 };

/** Fake Batch API: a batch "ends" after `pollsUntilEnded` retrieve() calls; results come from `script`. */
function fakeBatches(script: (p: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message, pollsUntilEnded = 1) {
  const created: Anthropic.Messages.BatchCreateParams['requests'][number][] = [];
  const polls = new Map<string, number>();
  const api: AnthropicBatchLike = {
    messages: {
      batches: {
        async create(params) {
          const req = params.requests[0]!;
          created.push(req);
          const id = `batch_${created.length}`;
          polls.set(id, 0);
          return { id } as Anthropic.Messages.MessageBatch;
        },
        async retrieve(id) {
          const n = (polls.get(id) ?? 0) + 1;
          polls.set(id, n);
          return { id, processing_status: n > pollsUntilEnded ? 'ended' : 'in_progress' } as Anthropic.Messages.MessageBatch;
        },
        async results(id) {
          const req = created[Number(id.split('_')[1]) - 1]!;
          const msg = script(req.params as Anthropic.MessageCreateParamsNonStreaming);
          return (async function* () {
            yield { custom_id: req.custom_id, result: { type: 'succeeded', message: msg } } as Anthropic.Messages.MessageBatchIndividualResponse;
          })();
        },
      },
    },
  };
  return { api, created };
}

async function setup(batches: AnthropicBatchLike | null, supportsBatch = true) {
  const db = openDb(':memory:');
  runMigrations(db);
  const conv = createConversation(db, { title: 'chat' }).id;
  const executed: string[] = [];
  const conn: McpConnectionLike = {
    name: 'srv',
    async listTools() { return [{ name: 'x', description: 'x', inputSchema: { type: 'object' } }]; },
    async callTool(name) { executed.push(name); return { text: `${name} ok`, isError: false }; },
  };
  const registry = new ToolRegistry(['x']);
  await registry.loadFrom([conn]);
  const router = {
    clientFor: () => ({ provider: 'anthropic', info: { supportsBatch }, client: { messages: { create: async () => { throw new Error('live client must not be used'); } } } }),
    anthropic: () => batches,
    redact: (m: string) => m,
  } as unknown as ProviderRouter;
  const usages: Array<{ batch?: boolean }> = [];
  const agents = new AgentManager({
    db, router, registry, approval: new WebApprovalGate(db), sse: new SSEManager(), limits: LIMITS, batchPollMs: 1,
    recordUsage: u => { usages.push({ batch: u.batch }); return 0; },
  });
  const root = createRun(db, { conversationId: conv, model: 'm', goal: 'orchestrate', label: 'assistant' });
  agents.registerRoot(root.id, new AbortController());
  return { db, agents, root, executed, usages };
}

const waitDone = async (db: ReturnType<typeof openDb>, id: string) => {
  for (let i = 0; i < 400; i++) {
    const r = getRun(db, id)!;
    if (!['running', 'waiting_input'].includes(r.status)) return r;
    await new Promise(r2 => setTimeout(r2, 5));
  }
  throw new Error('run did not finish');
};

describe('batched workers', () => {
  it('runs a tool loop as chained one-request batches and bills each step at the batch rate', async () => {
    let step = 0;
    const { api, created } = fakeBatches(p => {
      step++;
      if (step === 1) return message([{ type: 'tool_use', id: 't1', name: 'srv__x', input: {} }], 'tool_use');
      assert.ok(JSON.stringify(p.messages).includes('tool_result'), 'step 2 carries the tool result');
      return message([{ type: 'text', text: 'all done', citations: null }], 'end_turn');
    }, 2);
    const t = await setup(api);
    const tools = [...t.agents['toolsOf'](getRun(t.db, t.root.id)!)].filter(n => n.endsWith('x'));
    const r = t.agents.spawn(t.root.id, { goal: 'use x', model: 'm', tools, batch: true });
    assert.ok('runId' in r, JSON.stringify(r));
    const run = await waitDone(t.db, r.runId);
    assert.equal(run.status, 'done', run.error ?? '');
    assert.equal(run.batch, true);
    assert.match(run.result ?? '', /all done/);
    assert.equal(created.length, 2, 'one batch per model step');
    assert.equal(t.executed.length, 1, 'the tool ran locally between the batches');
    assert.ok(t.usages.length >= 2 && t.usages.every(u => u.batch === true));
  });

  it('refuses batch for a model without Batch API support, and without an Anthropic key', async () => {
    const t = await setup(fakeBatches(() => message([], 'end_turn')).api, false);
    const a = t.agents.spawn(t.root.id, { goal: 'g', model: 'm', batch: true });
    assert.ok('error' in a && /Anthropic model/.test(a.error), JSON.stringify(a));
    const t2 = await setup(null, true);
    const b = t2.agents.spawn(t2.root.id, { goal: 'g', model: 'm', batch: true });
    assert.ok('error' in b && /API key/.test(b.error), JSON.stringify(b));
  });

  it('stopping a worker aborts the poll loop', async () => {
    const { api } = fakeBatches(() => message([], 'end_turn'), 10_000);
    const c = createBatchedClient(api, { pollMs: 5 });
    const ac = new AbortController();
    const p = c.messages.create({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(p, /aborted/);
  });
});
