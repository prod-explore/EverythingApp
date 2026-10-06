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
    /**
     * Optional streaming variant. Anthropic's SDK client has it; providers that don't
     * (the OpenAI-compatible adapter) simply fall back to `create` — nothing breaks, the
     * reply just arrives in one piece instead of token by token.
     */
    stream?(params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): MessageStreamLike;
  };
}

/** The slice of the SDK's MessageStream the loop uses. */
export interface MessageStreamLike {
  on(event: 'streamEvent', listener: (event: Anthropic.MessageStreamEvent) => void): unknown;
  finalMessage(): Promise<Anthropic.Message>;
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
  /** `{ approved:false, reason }` = refused by policy rather than by a human; the reason is shown to the model. */
  confirm: (
    toolLabel: string,
    args: Record<string, unknown>,
    opts?: { forcePrompt?: string },
  ) => Promise<boolean | { approved: boolean; reason?: string }>;
  /** Called for every text block the model produces, in order. Always fires, with the complete block. */
  onAssistantText?: (text: string) => void;
  /**
   * Live text chunks while a response is still being generated; `block` is the content-block
   * index within that response, so a response with several text blocks can be told apart.
   * Only fires when the provider supports streaming. onAssistantText still follows with the final text.
   */
  onTextDelta?: (delta: { block: number; text: string }) => void;
  /** Called right before a tool actually executes (after approval). */
  onToolStart?: (toolLabel: string) => void;
  /** Called once per API response with that response's usage. */
  onUsage?: (usage: Anthropic.Usage) => void;
  /** Called after each tool call with the full (un-truncated) output — for UI display. */
  onToolResult?: (toolName: string, fullOutput: string, truncatedOutput: string, isError: boolean) => void;
  /** Hard cap on model round-trips in this turn (runaway-loop guard, used for subagents). Unlimited when unset. */
  maxSteps?: number;
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
  /**
   * The conversation's project, if it has one — injected as `_project_id` into sandbox tools so every chat
   * in a project shares one sandbox and workspace. Standalone chats fall back to `_conversation_id`.
   */
  projectId?: string;
  /**
   * Agents-lite: messages addressed to this run by other agents, drained at every step boundary and
   * appended to the latest user turn (so the alternation of roles stays valid). Each string is one message.
   */
  drainInbox?: () => string[];
  /** Project browser policy, injected as `_policy` into every browser tool call (never taken from the model). */
  browserPolicy?: { domainAllow?: string[]; domainDeny?: string[]; js?: 'disabled' | 'review' | 'allowed' };
  /** Called at the start of every step (model round-trip) — run heartbeat. */
  onStep?: (step: number) => void;
}

export class StepLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`Tool loop exceeded the ${limit}-step limit`);
    this.name = 'StepLimitError';
  }
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
  'terminal_list',
  'terminal_close',
  'browser_open',
  'browser_observe',
  'browser_act',
  'browser_close',
]);

/** Browser tools: get the orchestrator's `_policy`; model-supplied hidden args are stripped. */
const BROWSER_TOOL_NAMES = new Set(['browser_open', 'browser_observe', 'browser_act', 'browser_close', 'browse_url']);
/** Read-only tools that stay unprompted even after a page looked like a prompt injection. */
const READ_ONLY_AFTER_INJECTION = new Set(['browser_observe', 'browser_close', 'read_log', 'terminal_list']);
const BROWSER_META_PREFIX = '[browser-meta] ';

/** playwright-mcp puts `[browser-meta] {json}` on the first line of every observation (Observation v2). */
export function browserInjectionSignal(text: string): { suspected: boolean; reasons: string[] } {
  if (!text.startsWith(BROWSER_META_PREFIX)) return { suspected: false, reasons: [] };
  const nl = text.indexOf('\n');
  try {
    const meta = JSON.parse(text.slice(BROWSER_META_PREFIX.length, nl === -1 ? undefined : nl)) as { injection_suspected?: boolean; injection_reasons?: string[] };
    return { suspected: meta.injection_suspected === true, reasons: Array.isArray(meta.injection_reasons) ? meta.injection_reasons.map(String) : [] };
  } catch {
    return { suspected: false, reasons: [] };
  }
}

/** The subset of the above that lives in the project-scoped sandbox (the browser tools are per chat). */
const SANDBOX_TOOL_NAMES = new Set(['run_bash', 'git_op', 'read_log', 'terminal_list', 'terminal_close']);

function realToolName(exposedName: string): string {
  const parts = exposedName.split('__');
  return parts[parts.length - 1] ?? '';
}

function needsProjectId(exposedName: string): boolean {
  return SANDBOX_TOOL_NAMES.has(realToolName(exposedName));
}

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
 * Rolling cache breakpoint on the growing conversation. System + tools are cached, but in a tool loop the
 * history grows every step — without a breakpoint at its end each step re-bills the whole transcript at the
 * full input price. Applied to a COPY of the request only: the stored history must never carry cache_control
 * (the API allows 4 breakpoints per request, and stale ones would pile up).
 */
export function withHistoryCache(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  const blocks: Anthropic.ContentBlockParam[] =
    typeof last.content === 'string' ? (last.content ? [{ type: 'text', text: last.content }] : []) : [...last.content];
  const i = blocks.length - 1;
  const tail = blocks[i];
  // thinking blocks cannot carry cache_control; fall back to uncached rather than fail the request
  if (!tail || tail.type === 'thinking' || tail.type === 'redacted_thinking') return messages;
  blocks[i] = { ...tail, cache_control: { type: 'ephemeral' } } as Anthropic.ContentBlockParam;
  return [...messages.slice(0, -1), { ...last, content: blocks }];
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

  let steps = 0;
  // Set once a browser observation looked like a prompt injection: from then on every tool call with an
  // effect needs a fresh human approval (grants and auto-approve don't apply) — Plan v3 §6 step 3.
  let injectionWarning: string | null = null;
  for (;;) {
    // Kill switch check before each API call
    if (deps.signal?.aborted) throw new Error('Turn aborted by user (kill switch)');
    steps++;
    if (deps.maxSteps !== undefined && steps > deps.maxSteps) {
      throw new StepLimitError(deps.maxSteps);
    }
    deps.onStep?.(steps);
    const inbox = deps.drainInbox?.() ?? [];
    const lastMsg = messages[messages.length - 1];
    if (inbox.length > 0 && lastMsg?.role === 'user') {
      const blocks = typeof lastMsg.content === 'string' ? [{ type: 'text' as const, text: lastMsg.content }] : [...lastMsg.content];
      for (const text of inbox) blocks.push({ type: 'text', text });
      messages[messages.length - 1] = { role: 'user', content: blocks };
    }

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: deps.model,
      max_tokens: deps.maxTokens ?? 4096,
      system: cacheableSystem(deps.systemPrompt),
      tools: toolDefs.length > 0 ? cacheableTools(toolDefs) : undefined,
      messages: withHistoryCache(messages),
    };
    // Lets the kill switch cancel a request that's already in flight, not just the next one.
    const options = { signal: deps.signal };
    const onTextDelta = deps.onTextDelta;
    let response: Anthropic.Message;
    if (onTextDelta && deps.anthropic.messages.stream) {
      const stream = deps.anthropic.messages.stream(params, options);
      stream.on('streamEvent', event => {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
          onTextDelta({ block: event.index, text: event.delta.text });
        }
      });
      response = await stream.finalMessage();
    } else {
      response = await deps.anthropic.messages.create(params, options);
    }

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

      // A tool name that exists nowhere (hallucinated, or outside a subagent's allowlist) must fail
      // fast with an error the model can read — not park on the approval gate asking a human to
      // approve a call that can only ever return "Unknown tool".
      if (!virtual && !deps.tools.has(use.name)) {
        const result = { text: `Unknown tool: ${use.name}`, isError: true };
        deps.onToolResult?.(use.name, result.text, result.text, true);
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: result.text, is_error: true });
        continue;
      }

      const needsApproval = virtual ? virtual.requiresApproval === true : deps.tools.requiresApproval(use.name);
      const forcePrompt = injectionWarning && !READ_ONLY_AFTER_INJECTION.has(realToolName(use.name)) ? injectionWarning : undefined;
      const decision = needsApproval || forcePrompt ? await deps.confirm(label, args, forcePrompt ? { forcePrompt } : undefined) : true;
      const approved = typeof decision === 'boolean' ? decision : decision.approved;
      const denyReason = typeof decision === 'boolean' ? undefined : decision.reason;
      // Re-check AFTER the (possibly long) human wait: a kill switch pressed while this
      // call was parked on the approval gate must stop it, even if "Approve" arrives late.
      if (deps.signal?.aborted) throw new Error('Turn aborted by user (kill switch)');

      if (!approved) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: denyReason ? `Not executed — ${denyReason}.` : DENIED_MESSAGE,
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
        let enrichedArgs: Record<string, unknown> =
          deps.conversationId && needsConversationId(use.name)
            ? { ...args, _conversation_id: deps.conversationId }
            : args;
        // Set unconditionally (never trusted from the model): without it a model could pass a project id
        // of its own and reach another project's sandbox.
        if (needsProjectId(use.name)) {
          const { _project_id: _ignored, ...rest } = enrichedArgs;
          enrichedArgs = deps.projectId ? { ...rest, _project_id: deps.projectId } : rest;
        }
        if (BROWSER_TOOL_NAMES.has(realToolName(use.name))) {
          // Hidden policy args belong to the orchestrator: a model could otherwise widen its own policy
          // or allow downloads. Downloads stay blocked (playwright-mcp default).
          const { _policy: _p, _allow_downloads: _d, ...rest } = enrichedArgs;
          enrichedArgs = deps.browserPolicy ? { ...rest, _policy: deps.browserPolicy } : rest;
        }
        result = await deps.tools.call(use.name, enrichedArgs);
        if (BROWSER_TOOL_NAMES.has(realToolName(use.name))) {
          const signal = browserInjectionSignal(result.text);
          if (signal.suspected && !injectionWarning) {
            injectionWarning = `A web page in this turn looked like a prompt injection${signal.reasons.length ? ` (${signal.reasons.slice(0, 3).join('; ')})` : ''}. Check that this action is what you asked for.`;
          }
        }
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
