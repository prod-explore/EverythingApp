import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { runTurn, type AnthropicLike } from '../anthropic-loop.js';
import { ToolRegistry } from '../tool-registry.js';
import type { McpConnectionLike, McpToolInfo } from '../mcp-client.js';

function fakeConnection(name: string, tools: McpToolInfo[], calls: string[]): McpConnectionLike {
  return {
    name,
    async listTools() {
      return tools;
    },
    async callTool(toolName) {
      calls.push(toolName);
      return { text: `${toolName} ok`, isError: false };
    },
  };
}

/** Builds a minimally-valid fake Anthropic.Message — only the fields runTurn reads matter for the test. */
function fakeMessage(
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.StopReason,
): Anthropic.Message {
  return {
    id: 'msg_fake',
    container: null,
    content,
    model: 'claude-sonnet-5',
    role: 'assistant',
    stop_reason: stopReason,
    stop_sequence: null,
    type: 'message',
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
  } as unknown as Anthropic.Message;
}

function textBlock(text: string): Anthropic.ContentBlock {
  return { type: 'text', text, citations: null } as unknown as Anthropic.ContentBlock;
}

function toolUseBlock(id: string, name: string, input: Record<string, unknown>): Anthropic.ContentBlock {
  return { type: 'tool_use', id, name, input } as unknown as Anthropic.ContentBlock;
}

function scriptedAnthropic(responses: Anthropic.Message[]): AnthropicLike & { calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  let i = 0;
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        const response = responses[i];
        if (!response) throw new Error('scriptedAnthropic ran out of responses');
        i += 1;
        return response;
      },
    },
  };
}

async function registryWithSandbox(calls: string[], autoApprove: string[] = []): Promise<ToolRegistry> {
  const registry = new ToolRegistry(autoApprove);
  await registry.loadFrom([
    fakeConnection(
      'sandbox',
      [
        { name: 'run_bash', description: 'run a command', inputSchema: { type: 'object' } },
        { name: 'read_log', description: 'read the log', inputSchema: { type: 'object' } },
      ],
      calls,
    ),
  ]);
  return registry;
}

describe('runTurn', () => {
  it('returns immediately on a plain text reply, no tool calls made', async () => {
    const calls: string[] = [];
    const tools = await registryWithSandbox(calls);
    const anthropic = scriptedAnthropic([fakeMessage([textBlock('cześć')], 'end_turn')]);
    const texts: string[] = [];

    const history = await runTurn(
      { anthropic, model: 'claude-sonnet-5', tools, systemPrompt: 'sys', confirm: async () => true, onAssistantText: t => texts.push(t) },
      [],
      'hej',
    );

    assert.deepEqual(texts, ['cześć']);
    assert.deepEqual(calls, []);
    assert.equal(history.length, 2); // user + assistant
  });

  it('marks the system prompt and last tool def as cacheable (prompt caching)', async () => {
    const calls: string[] = [];
    const tools = await registryWithSandbox(calls, ['read_log']);
    const anthropic = scriptedAnthropic([fakeMessage([textBlock('cześć')], 'end_turn')]);

    await runTurn(
      { anthropic, model: 'claude-sonnet-5', tools, systemPrompt: 'sys prompt', confirm: async () => true },
      [],
      'hej',
    );

    const [request] = anthropic.calls;
    const system = request.system as Anthropic.TextBlockParam[];
    assert.equal(system[0]?.cache_control?.type, 'ephemeral');

    const toolDefs = request.tools as Anthropic.Tool[];
    assert.equal(toolDefs.at(-1)?.cache_control?.type, 'ephemeral');
    // Only the last tool def carries the breakpoint — caching a prefix doesn't need every entry marked.
    assert.equal(toolDefs[0]?.cache_control, undefined);
  });

  it('merges serverTools (e.g. web_search) alongside MCP tools, with the cache breakpoint on whichever is last', async () => {
    const calls: string[] = [];
    const tools = await registryWithSandbox(calls, ['read_log']);
    const anthropic = scriptedAnthropic([fakeMessage([textBlock('cześć')], 'end_turn')]);

    await runTurn(
      {
        anthropic,
        model: 'claude-sonnet-5',
        tools,
        systemPrompt: 'sys',
        serverTools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        confirm: async () => true,
      },
      [],
      'hej',
    );

    const [request] = anthropic.calls;
    const toolNames = (request.tools ?? []).map((t: any) => t.name);
    assert.deepEqual(toolNames.sort(), ['sandbox__read_log', 'sandbox__run_bash', 'web_search']);
    assert.equal((request.tools ?? []).at(-1)?.cache_control?.type, 'ephemeral');
  });

  it('executes an approved tool call and feeds the result back for a second turn', async () => {
    const calls: string[] = [];
    const tools = await registryWithSandbox(calls);
    const anthropic = scriptedAnthropic([
      fakeMessage([toolUseBlock('t1', 'sandbox__run_bash', { command: 'ls' })], 'tool_use'),
      fakeMessage([textBlock('gotowe')], 'end_turn'),
    ]);
    let confirmed = false;

    const history = await runTurn(
      {
        anthropic,
        model: 'claude-sonnet-5',
        tools,
        systemPrompt: 'sys',
        confirm: async () => {
          confirmed = true;
          return true;
        },
      },
      [],
      'zrób ls',
    );

    assert.equal(confirmed, true);
    assert.deepEqual(calls, ['run_bash']);
    // user, assistant(tool_use), user(tool_result), assistant(text)
    assert.equal(history.length, 4);
    const toolResultMsg = history[2];
    assert.equal(toolResultMsg.role, 'user');
  });

  it('does not execute the tool when the approval gate denies it, and tells the model why', async () => {
    const calls: string[] = [];
    const tools = await registryWithSandbox(calls);
    const anthropic = scriptedAnthropic([
      fakeMessage([toolUseBlock('t1', 'sandbox__run_bash', { command: 'rm -rf /' })], 'tool_use'),
      fakeMessage([textBlock('ok, nie robię tego')], 'end_turn'),
    ]);

    const history = await runTurn(
      { anthropic, model: 'claude-sonnet-5', tools, systemPrompt: 'sys', confirm: async () => false },
      [],
      'zrób coś ryzykownego',
    );

    assert.deepEqual(calls, []); // tool never actually ran
    const toolResultMsg = history[2] as Anthropic.MessageParam;
    const block = (toolResultMsg.content as Anthropic.ToolResultBlockParam[])[0];
    assert.equal(block.is_error, true);
  });

  it('skips the confirm step entirely for whitelisted (read-only) tools', async () => {
    const calls: string[] = [];
    const tools = await registryWithSandbox(calls, ['read_log']);
    const anthropic = scriptedAnthropic([
      fakeMessage([toolUseBlock('t1', 'sandbox__read_log', {})], 'tool_use'),
      fakeMessage([textBlock('oto log')], 'end_turn'),
    ]);
    let confirmCalls = 0;

    await runTurn(
      {
        anthropic,
        model: 'claude-sonnet-5',
        tools,
        systemPrompt: 'sys',
        confirm: async () => {
          confirmCalls += 1;
          return true;
        },
      },
      [],
      'pokaż log',
    );

    assert.equal(confirmCalls, 0);
    assert.deepEqual(calls, ['read_log']);
  });
});

describe('runTurn — _conversation_id injection (§6b: generalized beyond sandbox tools)', () => {
  function connectionCapturingArgs(name: string, toolNames: string[], calls: Array<{ tool: string; args: Record<string, unknown> }>): McpConnectionLike {
    return {
      name,
      async listTools() {
        return toolNames.map(n => ({ name: n, description: n, inputSchema: { type: 'object' } }));
      },
      async callTool(toolName, args) {
        calls.push({ tool: toolName, args: args ?? {} });
        return { text: `${toolName} ok`, isError: false };
      },
    };
  }

  it('injects _conversation_id into browser_act calls (a stateful §6b tool), like it already does for run_bash', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const registry = new ToolRegistry(['browser_act']); // auto-approve to skip the confirm() prompt in this test
    await registry.loadFrom([connectionCapturingArgs('playwright', ['browser_act'], calls)]);

    const anthropic = scriptedAnthropic([
      fakeMessage([toolUseBlock('t1', 'playwright__browser_act', { action: 'click', ref: 1, label: 'Search' })], 'tool_use'),
      fakeMessage([textBlock('done')], 'end_turn'),
    ]);

    await runTurn(
      {
        anthropic,
        model: 'claude-sonnet-5',
        tools: registry,
        systemPrompt: 'sys',
        confirm: async () => true,
        conversationId: 'conv-abc123',
      },
      [],
      'click search',
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.args['_conversation_id'], 'conv-abc123');
    // The model's own args are preserved alongside the injected one.
    assert.equal(calls[0]!.args['action'], 'click');
  });

  it('does NOT inject _conversation_id into a non-stateful tool (e.g. browse_url)', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const registry = new ToolRegistry(['browse_url']);
    await registry.loadFrom([connectionCapturingArgs('playwright', ['browse_url'], calls)]);

    const anthropic = scriptedAnthropic([
      fakeMessage([toolUseBlock('t1', 'playwright__browse_url', { url: 'https://example.com', extract: 'title' })], 'tool_use'),
      fakeMessage([textBlock('done')], 'end_turn'),
    ]);

    await runTurn(
      {
        anthropic,
        model: 'claude-sonnet-5',
        tools: registry,
        systemPrompt: 'sys',
        confirm: async () => true,
        conversationId: 'conv-abc123',
      },
      [],
      'get the title',
    );

    assert.equal(calls.length, 1);
    assert.equal('_conversation_id' in calls[0]!.args, false);
  });
});

describe('runTurn — virtual tools (executed in-loop by the orchestrator)', () => {
  const askTool: Anthropic.Tool = {
    name: 'ask_user',
    description: 'queue a question',
    input_schema: { type: 'object', properties: { q: { type: 'string' } } },
  };

  it('runs a virtual tool inside the loop and feeds back a real tool_result — no approval, no registry', async () => {
    const registry = new ToolRegistry([]);
    const seenInputs: Record<string, unknown>[] = [];
    const confirmCalls: string[] = [];
    const client = scriptedAnthropic([
      fakeMessage([toolUseBlock('tu_1', 'ask_user', { q: 'why?' })], 'tool_use'),
      fakeMessage([textBlock('done')], 'end_turn'),
    ]);

    const history = await runTurn(
      {
        anthropic: client,
        model: 'm',
        tools: registry,
        systemPrompt: 's',
        virtualTools: [{ definition: askTool, handler: async input => { seenInputs.push(input); return { text: 'queued' }; } }],
        confirm: async label => { confirmCalls.push(label); return true; },
      },
      [],
      'hi',
    );

    assert.deepEqual(seenInputs, [{ q: 'why?' }]);
    assert.deepEqual(confirmCalls, [], 'a virtual tool without requiresApproval must not hit the approval gate');
    // The model must see the virtual tool's definition…
    assert.ok((client.calls[0]!.tools as Anthropic.Tool[]).some(t => t.name === 'ask_user'));
    // …and a real result (not "Unknown tool") for the real tool_use id.
    const results = history.at(-2)!.content as Anthropic.ToolResultBlockParam[];
    assert.equal(results[0]!.tool_use_id, 'tu_1');
    assert.equal(results[0]!.content, 'queued');
    assert.notEqual(results[0]!.is_error, true);
  });

  it('routes a virtual tool through the approval gate only when requiresApproval is set, and respects a denial', async () => {
    const registry = new ToolRegistry([]);
    let ran = false;
    const confirmCalls: string[] = [];
    const client = scriptedAnthropic([
      fakeMessage([toolUseBlock('tu_1', 'ask_user', {})], 'tool_use'),
      fakeMessage([textBlock('ok')], 'end_turn'),
    ]);
    const history = await runTurn(
      {
        anthropic: client,
        model: 'm',
        tools: registry,
        systemPrompt: 's',
        virtualTools: [{ definition: askTool, requiresApproval: true, handler: async () => { ran = true; return { text: 'x' }; } }],
        confirm: async label => { confirmCalls.push(label); return false; },
      },
      [],
      'hi',
    );
    assert.deepEqual(confirmCalls, ['ask_user']);
    assert.equal(ran, false);
    const results = history.at(-2)!.content as Anthropic.ToolResultBlockParam[];
    assert.equal(results[0]!.is_error, true);
  });

  it('turns a throwing virtual-tool handler into an is_error result instead of crashing the turn', async () => {
    const client = scriptedAnthropic([
      fakeMessage([toolUseBlock('tu_1', 'ask_user', {})], 'tool_use'),
      fakeMessage([textBlock('recovered')], 'end_turn'),
    ]);
    const history = await runTurn(
      {
        anthropic: client,
        model: 'm',
        tools: new ToolRegistry([]),
        systemPrompt: 's',
        virtualTools: [{ definition: askTool, handler: async () => { throw new Error('boom'); } }],
        confirm: async () => true,
      },
      [],
      'hi',
    );
    const results = history.at(-2)!.content as Anthropic.ToolResultBlockParam[];
    assert.equal(results[0]!.is_error, true);
    assert.match(String(results[0]!.content), /boom/);
  });
});

describe('runTurn — kill switch while parked on the approval gate', () => {
  it('does not execute the tool when the kill switch fires during confirm(), even if the human then approves', async () => {
    const calls: string[] = [];
    const registry = await registryWithSandbox(calls);
    const controller = new AbortController();
    const client = scriptedAnthropic([
      fakeMessage([toolUseBlock('tu_1', 'sandbox__run_bash', { command: 'ls' })], 'tool_use'),
    ]);
    await assert.rejects(
      runTurn(
        {
          anthropic: client,
          model: 'm',
          tools: registry,
          systemPrompt: 's',
          signal: controller.signal,
          // Human clicks "Approve" only AFTER the kill switch was pressed.
          confirm: async () => { controller.abort(); return true; },
        },
        [],
        'hi',
      ),
      /kill switch/,
    );
    assert.deepEqual(calls, [], 'the tool must not run after the turn was killed');
  });
});

describe('runTurn — streaming text deltas (N2b)', () => {
  const baseDeps = (client: AnthropicLike, extra: Record<string, unknown> = {}) => ({
    anthropic: client,
    model: 'claude-sonnet-5',
    tools: new ToolRegistry([]),
    systemPrompt: 'sys',
    confirm: async () => true,
    ...extra,
  });

  it('forwards text deltas live, then still reports the complete block via onAssistantText', async () => {
    let createCalls = 0;
    const client: AnthropicLike = {
      messages: {
        async create() {
          createCalls++;
          throw new Error('create must not be used when stream is available');
        },
        stream() {
          let listener: ((e: Anthropic.MessageStreamEvent) => void) | undefined;
          return {
            on(_event, l) {
              listener = l;
            },
            async finalMessage() {
              for (const text of ['Hel', 'lo']) {
                listener?.({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as Anthropic.MessageStreamEvent);
              }
              // Non-text deltas (tool input JSON) must be ignored.
              listener?.({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } } as Anthropic.MessageStreamEvent);
              return fakeMessage([textBlock('Hello')], 'end_turn');
            },
          };
        },
      },
    };
    const deltas: Array<{ block: number; text: string }> = [];
    const finals: string[] = [];
    await runTurn(
      baseDeps(client, { onTextDelta: (d: { block: number; text: string }) => deltas.push(d), onAssistantText: (t: string) => finals.push(t) }) as never,
      [],
      'hi',
    );
    assert.deepEqual(deltas, [{ block: 0, text: 'Hel' }, { block: 0, text: 'lo' }]);
    assert.deepEqual(finals, ['Hello']);
    assert.equal(createCalls, 0);
  });

  it('falls back to create() when the client has no stream (e.g. the OpenAI-compatible adapter)', async () => {
    const client: AnthropicLike = {
      messages: {
        async create() {
          return fakeMessage([textBlock('whole')], 'end_turn');
        },
      },
    };
    const deltas: unknown[] = [];
    const finals: string[] = [];
    await runTurn(
      baseDeps(client, { onTextDelta: (d: unknown) => deltas.push(d), onAssistantText: (t: string) => finals.push(t) }) as never,
      [],
      'hi',
    );
    assert.deepEqual(deltas, []);
    assert.deepEqual(finals, ['whole']);
  });

  it('does not stream when nobody listens for deltas (subagents, batch)', async () => {
    let streamed = false;
    const client: AnthropicLike = {
      messages: {
        async create() {
          return fakeMessage([textBlock('x')], 'end_turn');
        },
        stream() {
          streamed = true;
          throw new Error('should not be called');
        },
      },
    };
    await runTurn(baseDeps(client) as never, [], 'hi');
    assert.equal(streamed, false);
  });
});

describe('runTurn — _project_id injection (N3: one sandbox per project)', () => {
  async function runWith(toolName: string, modelArgs: Record<string, unknown>, deps: { projectId?: string }) {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const registry = new ToolRegistry([toolName]);
    await registry.loadFrom([
      {
        name: 'sandbox',
        async listTools() {
          return [{ name: toolName, description: toolName, inputSchema: { type: 'object' } }];
        },
        async callTool(name, args) {
          calls.push({ tool: name, args: args ?? {} });
          return { text: 'ok', isError: false };
        },
      } as McpConnectionLike,
    ]);
    await runTurn(
      {
        anthropic: scriptedAnthropic([
          fakeMessage([toolUseBlock('t1', `sandbox__${toolName}`, modelArgs)], 'tool_use'),
          fakeMessage([textBlock('done')], 'end_turn'),
        ]),
        model: 'claude-sonnet-5',
        tools: registry,
        systemPrompt: 'sys',
        confirm: async () => true,
        conversationId: 'conv-1',
        ...deps,
      },
      [],
      'go',
    );
    return calls[0]!.args;
  }

  it('sandbox tools get the conversation id and the project id', async () => {
    const args = await runWith('run_bash', { command: 'ls' }, { projectId: 'proj-9' });
    assert.equal(args['_conversation_id'], 'conv-1');
    assert.equal(args['_project_id'], 'proj-9');
    assert.equal(args['command'], 'ls');
  });

  it('a standalone chat sends no _project_id, so its own sandbox is used', async () => {
    const args = await runWith('run_bash', { command: 'ls' }, {});
    assert.equal('_project_id' in args, false);
  });

  it("a model-supplied _project_id is overwritten, so one project's agent cannot reach another's sandbox", async () => {
    const withProject = await runWith('run_bash', { command: 'ls', _project_id: 'someone-elses' }, { projectId: 'mine' });
    assert.equal(withProject['_project_id'], 'mine');
    const standalone = await runWith('terminal_list', { _project_id: 'someone-elses' }, {});
    assert.equal('_project_id' in standalone, false);
  });

  it('terminal tools are scoped like run_bash', async () => {
    const args = await runWith('terminal_close', { terminal: 'dev' }, { projectId: 'p' });
    assert.equal(args['_project_id'], 'p');
    assert.equal(args['_conversation_id'], 'conv-1');
  });

  it('browser tools keep a per-chat session and never receive a project id', async () => {
    const args = await runWith('browser_act', { action: 'click' }, { projectId: 'p' });
    assert.equal(args['_conversation_id'], 'conv-1');
    assert.equal('_project_id' in args, false);
  });
});
