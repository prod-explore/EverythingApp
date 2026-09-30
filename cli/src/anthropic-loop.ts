import type Anthropic from '@anthropic-ai/sdk';
import type { ToolRegistry } from './tool-registry.js';
import { truncateToolOutput } from './output-truncator.js';

/**
 * The one method the tool loop needs from any provider. Anthropic's SDK client
 * satisfies it as-is; the OpenAI-compatible adapter (providers/openai-compat.ts)
 * implements it by translating to/from chat-completions, so this loop never
 * knows or cares which provider it is talking to. Also what tests inject.
 */
export interface LlmClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Anthropic.Message>;
  };
}

/** @deprecated pre-Phase-3 name, kept so existing imports/tests keep working. */
export type AnthropicLike = LlmClient;

/**
 * In-process tool the orchestrator itself executes (e.g. request_human_input,
 * spawn_subagent). Unlike MCP tools it never goes through ToolRegistry, but it
 * runs INSIDE the tool loop: the model gets a real tool_result for the real
 * tool_use id, in order, in the same turn. Names must not contain "__" (that
 * separator is reserved for "<mcp-server>__<tool>").
 */
export interface VirtualToolContext {
  toolUseId: string;
  conversationId?: string;
  signal?: AbortSignal;
}

export interface VirtualTool {
  definition: Anthropic.Tool;
  /** Route through the approval gate before running. Default: false. */
  requiresApproval?: boolean;
  handler(input: Record<string, unknown>, ctx: VirtualToolContext): Promise<{ text: string; isError?: boolean }>;
}

export interface ConversationDeps {
  /** Any provider's client — despite the historical field name. */
  anthropic: LlmClient;
  model: string;
  maxTokens?: number;
  tools: ToolRegistry;
  systemPrompt: string;
  /** Anthropic-hosted tools (e.g. web_search) — executed server-side, never routed through ToolRegistry or the approval gate. */
  serverTools?: Anthropic.ToolUnion[];
  /** Orchestrator-executed tools, run inside the loop (see VirtualTool). */
  virtualTools?: VirtualTool[];
  /** Ask a human yes/no before a side-effecting tool call runs. */
  confirm: (toolLabel: string, args: Record<string, unknown>) => Promise<boolean>;
  /** Called for every text block the model produces, in order. */
  onAssistantText?: (text: string) => void;
  /** Called right before a tool actually executes (after approval). */
  onToolStart?: (toolLabel: string) => void;
  /** Called once per API response with that response's usage. */
  onUsage?: (usage: Anthropic.Usage) => void;
  /** Called after each tool call with the full (un-truncated) output — for UI display. */
  onToolResult?: (toolName: string, fullOutput: string, truncatedOutput: string, isError: boolean) => void;
  /** AbortSignal — set by the kill switch (POST /api/conversations/:id/kill). */
  signal?: AbortSignal;
  /** Max tool output length in characters before truncating for the model context. Default 30 000. */
  maxToolOutputLength?: number;
  /**
   * Current conversation ID — injected into sandbox tool args as `_conversation_id`
   * so the sandbox-supervisor can maintain sticky per-conversation container leases.
   * The model never needs to supply this; the orchestrator sets it.
   */
  conversationId?: string;
}

const DENIED_MESSAGE = 'Rejected by user (approval gate) — not executed.';

/**
 * Tools that are pinned to one conversation and need `_conversation_id`
 * injected so their MCP server can maintain a sticky per-conversation
 * lease — the sandbox's container pool (§Phase 4) and, since §6b, the
 * playwright-mcp browser session pool work the same way. Matches by the
 * real tool name portion (after the `__` separator ToolRegistry uses for
 * namespacing).
 */
const STATEFUL_TOOL_NAMES = new Set([
  'run_bash',
  'git_op',
  'read_log',
  'browser_open',
  'browser_observe',
  'browser_act',
  'browser_close',
]);

function needsConversationId(exposedName: string): boolean {
  const parts = exposedName.split('__');
  const realName = parts[parts.length - 1];
  return STATEFUL_TOOL_NAMES.has(realName ?? '');
}

/**
 * db.ts round-trips messages through JSON.stringify/parse with no schema
 * enforcement, and every caller hands the result to us as `Anthropic.
 * MessageParam[]` via a bare type cast — not an actual guarantee about
 * what's in there. Strip anything Anthropic's API doesn't define before it
 * ever reaches `messages.create`/`batches.create`, so a stray field (e.g. a
 * frontend-only `id` that leaked into a stored message) gets dropped here
 * instead of surfacing as an opaque 400 from the API mid-turn.
 */
export function sanitizeHistory(history: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return history.map(msg => ({
    role: msg.role,
    content: typeof msg.content === 'string' ? msg.content : msg.content.map(sanitizeBlock),
  }));
}

function sanitizeBlock(block: Anthropic.ContentBlockParam): Anthropic.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content, is_error: block.is_error };
    default:
      // Unhandled block type (e.g. image) — pass through as-is rather than
      // silently dropping content this app doesn't otherwise deal with.
      return block;
  }
}

/**
 * System prompt + tool definitions are identical on every single request in
 * a session — the textbook case for prompt caching. Marking the last block
 * in each with cache_control caches everything up to and including it.
 */
export function cacheableSystem(systemPrompt: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
}

function cacheableTools(tools: Anthropic.ToolUnion[]): Anthropic.ToolUnion[] {
  if (tools.length === 0) return tools;
  const withCache = [...tools];
  const last = withCache[withCache.length - 1];
  withCache[withCache.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
  return withCache;
}

/**
 * Runs one user turn to completion: sends the message, and if Claude asks to
 * use tools, executes them (through the Approval Gate where required) and
 * feeds the results back — repeating until Claude replies with plain text
 * instead of another tool_use. Returns the updated history.
 */
export async function runTurn(
  deps: ConversationDeps,
  history: Anthropic.MessageParam[],
  userContent: Anthropic.MessageParam['content'],
): Promise<Anthropic.MessageParam[]> {
  const messages: Anthropic.MessageParam[] = [...sanitizeHistory(history), { role: 'user', content: userContent }];
  const virtualByName = new Map((deps.virtualTools ?? []).map(v => [v.definition.name, v]));
  const toolDefs: Anthropic.ToolUnion[] = [
    ...(deps.tools.toAnthropicTools() as Anthropic.Tool[]),
    ...(deps.virtualTools ?? []).map(v => v.definition),
    ...(deps.serverTools ?? []),
  ];

  for (;;) {
    // Kill switch check before each API call
    if (deps.signal?.aborted) throw new Error('Turn aborted by user (kill switch)');

    const response = await deps.anthropic.messages.create(
      {
        model: deps.model,
        max_tokens: deps.maxTokens ?? 4096,
        system: cacheableSystem(deps.systemPrompt),
        tools: toolDefs.length > 0 ? cacheableTools(toolDefs) : undefined,
        messages,
      },
      // Lets the kill switch cancel a request that's already in flight, not just the next one.
      { signal: deps.signal },
    );

    messages.push({ role: 'assistant', content: response.content });
    deps.onUsage?.(response.usage);

    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        deps.onAssistantText?.(block.text);
      }
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return messages;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      // Kill switch check before each tool execution
      if (deps.signal?.aborted) throw new Error('Turn aborted by user (kill switch)');

      const virtual = virtualByName.get(use.name);
      const label = virtual ? use.name : deps.tools.describe(use.name);
      const args = (use.input ?? {}) as Record<string, unknown>;

      const needsApproval = virtual ? virtual.requiresApproval === true : deps.tools.requiresApproval(use.name);
      const approved = !needsApproval || (await deps.confirm(label, args));
      // Re-check AFTER the (possibly long) human wait: a kill switch pressed while this
      // call was parked on the approval gate must stop it, even if "Approve" arrives late.
      if (deps.signal?.aborted) throw new Error('Turn aborted by user (kill switch)');

      if (!approved) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: DENIED_MESSAGE,
          is_error: true,
        });
        continue;
      }

      deps.onToolStart?.(label);

      let result: { text: string; isError?: boolean };
      if (virtual) {
        try {
          result = await virtual.handler(args, { toolUseId: use.id, conversationId: deps.conversationId, signal: deps.signal });
        } catch (err) {
          if (deps.signal?.aborted) throw err;
          result = { text: `Tool ${use.name} failed: ${(err as Error).message}`, isError: true };
        }
      } else {
        // Inject _conversation_id for tools that need a sticky per-conversation
        // lease (sandbox container, or — since §6b — a browser session). The
        // model never provides this — the orchestrator owns it.
        const enrichedArgs =
          deps.conversationId && needsConversationId(use.name)
            ? { ...args, _conversation_id: deps.conversationId }
            : args;
        result = await deps.tools.call(use.name, enrichedArgs);
      }
      const isError = result.isError === true;

      // Truncate long tool outputs for the model; keep full output for UI
      const { truncated, wasTruncated } = truncateToolOutput(result.text, deps.maxToolOutputLength);
      deps.onToolResult?.(use.name, result.text, truncated, isError);

      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: wasTruncated ? truncated : result.text,
        is_error: isError,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }
}
