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
