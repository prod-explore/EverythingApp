import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as Llm from '../llm-types.js';
import { runTurn, type ConversationDeps, type LlmClient, type VirtualTool } from '../llm-loop.js';
import { ToolRegistry } from '../tool-registry.js';
import type { McpConnectionLike } from '../mcp-client.js';
import { createApprovalGrant, createConversation, createProject, listGrantedWebHosts, openDb, runMigrations } from '../db.js';
import { WebApprovalGate } from '../web-approval.js';
import { loadConfig } from '../config.js';

function msg(content: Llm.ContentBlock[], stop: Llm.StopReason): Llm.Message {
  return {
    id: 'm', container: null, content, model: '@t/m', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message',
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null },
  } as unknown as Llm.Message;
}
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as unknown as Llm.ContentBlock;
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input }) as unknown as Llm.ContentBlock;
function scripted(responses: Llm.Message[]): LlmClient {
  let i = 0;
  return { messages: { async create() { const r = responses[i++]; if (!r) throw new Error('out of responses'); return r; } } };
}

interface Call { tool: string; args: Record<string, unknown> }
type Reply = string | { text: string; isError?: boolean };
async function browserRegistry(calls: Call[], autoApprove: string[], replies: Record<string, Reply> = {}): Promise<ToolRegistry> {
  const registry = new ToolRegistry(autoApprove);
  const conn: McpConnectionLike = {
    name: 'playwright',
    async listTools() {
      return ['browser_open', 'browser_observe', 'browser_act', 'browser_close'].map(n => ({ name: n, description: n, inputSchema: { type: 'object' } }));
    },
    async callTool(tool, args) {
      calls.push({ tool, args: args ?? {} });
      const r = replies[tool] ?? `${tool} ok`;
      return typeof r === 'string' ? { text: r, isError: false } : { isError: false, ...r };
    },
  };
  await registry.loadFrom([conn]);
  return registry;
}

const DEFAULT_AUTO = loadConfig().autoApproveTools;

function fetchTool(ran: Array<Record<string, unknown>>, reply = 'page text'): VirtualTool {
  return {
    definition: { name: 'web_fetch', description: 'fetch', input_schema: { type: 'object', properties: { url: { type: 'string' } } } },
    handler: async input => { ran.push(input); return { text: reply }; },
  };
}

interface ConfirmCall { label: string; args: Record<string, unknown>; forcePrompt?: string }
function deps(over: Partial<ConversationDeps> & { llm: LlmClient; tools: ToolRegistry }, confirms: ConfirmCall[], answer: (c: ConfirmCall) => boolean = () => true): ConversationDeps {
  return {
    model: '@t/m',
    systemPrompt: 's',
    conversationId: 'conv-1',
    confirm: async (label, args, opts) => { const c = { label, args, forcePrompt: opts?.forcePrompt }; confirms.push(c); return answer(c); },
    ...over,
  };
}

import { previewHostFor, previewTool } from '../preview.js';

describe('preview host', () => {
  it('matches the supervisor (same test vector as sandbox-supervisor/src/__tests__/preview.test.ts)', () => {
    assert.equal(previewHostFor('abc'), 'sandbox-a9993e3647');
    assert.match(previewHostFor('4f5a2c9e-1111-4222-8333-444455556666'), /^sandbox-[0-9a-f]{10}$/);
  });
});

describe('preview_sandbox tool', () => {
  it('links the owner and returns the URL for the port', async () => {
    const linked: string[] = [];
    const t = previewTool({ owner: 'proj-1', link: async o => { linked.push(o); return { host: 'sandbox-a9993e3647' }; } });
    const r = await t.handler({ port: 5173 }, { toolUseId: 'x' });
    assert.deepEqual(linked, ['proj-1']);
    assert.ok(!r.isError);
    assert.match(r.text, /http:\/\/sandbox-a9993e3647:5173\//);
    assert.match(r.text, /0\.0\.0\.0/);
    assert.equal(t.requiresApproval, undefined);
  });

  it('rejects a bad port without calling the supervisor', async () => {
    let called = false;
    const t = previewTool({ owner: 'p', link: async () => { called = true; return { host: 'h' }; } });
    for (const port of [0, 70000, 1.5, 'abc', undefined]) {
      const r = await t.handler({ port }, { toolUseId: 'x' });
      assert.equal(r.isError, true);
    }
    assert.equal(called, false);
  });

  it('reports a supervisor failure to the model', async () => {
    const t = previewTool({ owner: 'p', link: async () => { throw new Error('Preview is not configured'); } });
    const r = await t.handler({ port: 3000 }, { toolUseId: 'x' });
    assert.equal(r.isError, true);
    assert.match(r.text, /not configured/);
  });
});

describe('browser_open of the chat\'s own sandbox', () => {
  const own = previewHostFor('conv-1');

  it('needs no approval, and the host is added to the granted list for playwright', async () => {
    const calls: Call[] = [];
    const confirms: ConfirmCall[] = [];
    await runTurn(deps({
      llm: scripted([msg([use('1', 'playwright__browser_open', { url: `http://${own}:5173/` })], 'tool_use'), msg([text('ok')], 'end_turn')]),
      tools: await browserRegistry(calls, DEFAULT_AUTO),
      webAccess: { grantedHosts: () => ['docs.example.com'], ownHost: own },
    }, confirms), [], 'open');
    assert.equal(confirms.length, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual((calls[0]!.args['_policy'] as Record<string, unknown>)['domainGrant'], ['docs.example.com', own]);
  });

  it('another chat\'s sandbox host is an ordinary domain: the user is asked', async () => {
    const calls: Call[] = [];
    const confirms: ConfirmCall[] = [];
    const other = previewHostFor('someone-else');
    await runTurn(deps({
      llm: scripted([msg([use('1', 'playwright__browser_open', { url: `http://${other}:5173/` })], 'tool_use'), msg([text('ok')], 'end_turn')]),
      tools: await browserRegistry(calls, DEFAULT_AUTO),
      webAccess: { grantedHosts: () => [], ownHost: own },
    }, confirms), [], 'open');
    assert.deepEqual(confirms.map(c => c.label), [`web:${other}`]);
  });

  it('web_fetch never takes the shortcut (it runs on the server, which cannot see the sandbox)', async () => {
    const ran: Array<Record<string, unknown>> = [];
    const confirms: ConfirmCall[] = [];
    const history = await runTurn(deps({
      llm: scripted([msg([use('1', 'web_fetch', { url: `http://${own}:5173/` })], 'tool_use'), msg([text('ok')], 'end_turn')]),
      tools: new ToolRegistry([]),
      virtualTools: [fetchTool(ran)],
      webAccess: { grantedHosts: () => [], ownHost: own },
    }, confirms), [], 'fetch');
    assert.equal(ran.length, 0);
    assert.ok((history[2]!.content as Llm.ToolResultBlockParam[])[0]!.is_error);
  });
});
