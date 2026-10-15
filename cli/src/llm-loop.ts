import type * as Llm from './llm-types.js';
import type { ToolRegistry } from './tool-registry.js';
import { truncateToolOutput } from './output-truncator.js';
import { estimateTokens, trimForContext, TRIM_AT } from './context.js';
import { looksDangerous } from './web-approval.js';
import { collectContextUrls, urlIsInContext } from './web/provenance.js';
import { assertPublicUrl, hostOfUrl, UrlBlockedError } from './web/url-safety.js';

/**
 * The one method the tool loop needs from any provider. The OpenAI-compatible adapter
 * (providers/openai-compat.ts) implements it by translating to/from chat-completions, so this loop
 * never knows or cares which provider it is talking to. Also what tests inject.
 */
export interface LlmClient {
  messages: {
    create(
      params: Llm.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Llm.Message>;
    /**
     * Optional streaming variant. A client without it (Gemini, test doubles) simply falls back to
     * `create` — nothing breaks, the reply just arrives in one piece instead of token by token.
     */
    stream?(params: Llm.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): MessageStreamLike;
  };
}

/** What the loop needs from a streaming call. */
export interface MessageStreamLike {
  on(event: 'streamEvent', listener: (event: Llm.MessageStreamEvent) => void): unknown;
  finalMessage(): Promise<Llm.Message>;
}

/**
 * In-process tool the orchestrator itself executes (e.g. request_human_input,
 * spawn_agent). Unlike MCP tools it never goes through ToolRegistry, but it
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
  definition: Llm.Tool;
  /** Route through the approval gate before running. Default: false. */
  requiresApproval?: boolean;
  /** Always ask a human, never covered by a grant; the text is shown with the request. */
  alwaysAsk?: string;
  handler(input: Record<string, unknown>, ctx: VirtualToolContext): Promise<{ text: string; isError?: boolean }>;
}

export interface ConversationDeps {
  /** The model client (any provider). */
  llm: LlmClient;
  model: string;
  maxTokens?: number;
  tools: ToolRegistry;
  systemPrompt: string;
  /** Orchestrator-executed tools, run inside the loop (see VirtualTool). */
  virtualTools?: VirtualTool[];
  /**
   * Ask a human yes/no before a side-effecting tool call runs.
   * `{ approved:false, reason }` = refused by policy rather than by a human; the reason is shown to the model. */
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
  /** Live reasoning chunks (same conditions as onTextDelta). The complete reasoning is also stored as a `thinking` block. */
  onThinkingDelta?: (delta: { text: string }) => void;
  /** Called right before a tool actually executes (after approval). */
  onToolStart?: (toolLabel: string) => void;
  /** Called once per API response with that response's usage. */
  onUsage?: (usage: Llm.Usage) => void;
  /** Called after each tool call with the full (un-truncated) output and the truncated text the model gets. */
  onToolResult?: (toolName: string, fullOutput: string, truncatedOutput: string, isError: boolean) => void;
  /** Hard cap on model round-trips in this turn (runaway-loop guard, used for subagents). Unlimited when unset. */
  maxSteps?: number;
  /** AbortSignal — set by the kill switch (POST /api/conversations/:id/kill). */
  signal?: AbortSignal;
  /** Max tool output length in characters before truncating for the model context. Default 12 000 (see output-truncator.ts). */
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
  /**
   * Per-domain web access (web_fetch and the browser). When set, `browser_open` and `web_fetch` ask the user once per
   * domain (grant label `web:<host>`), and the browser only goes to domains in `grantedHosts()` (persistent grants,
   * evaluated on every call so a revoked grant stops working at once) or the one approved in this very call.
   * Without it the browser keeps the project policy alone (tests, headless callers).
   */
  webAccess?: { grantedHosts(): string[] };
  /**
   * web_fetch opens, without asking, only URLs that are already in the conversation: typed by the user (this flag
   * on) or returned by web_search / web_fetch. Subagents get false: their "user message" is a goal written by a model.
   * Default true.
   */
  userUrlsTrusted?: boolean;
  /** Called at the start of every step (model round-trip) — run heartbeat. */
  onStep?: (step: number) => void;
  /**
   * Called with the messages the turn has produced since the last call (assistant replies and tool results, in order),
   * before every model request, when the turn ends and when it fails. A tool call that was cut short is closed with an
   * error result first, so every `tool_use` handed over has its `tool_result`. Lets the caller store a turn as it
   * happens instead of only when it completes. The user message that started the turn is not included.
   */
  onMessages?: (messages: Llm.MessageParam[]) => void;
  /** The model's context window in tokens, when known: old tool outputs are dropped from the request as it fills up. */
  contextWindow?: number;
  /** Called with the provider-measured prompt size after every response. */
  onContext?: (info: { used: number; limit?: number }) => void;
  /** Passed to the model on every request; the adapter drops it for models that do not support it. */
  reasoningEffort?: 'low' | 'medium' | 'high';
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
/** Browser tools: per chat; they get the orchestrator's `_policy`, model-supplied hidden args are stripped. */
const BROWSER_TOOL_NAMES = new Set(['browser_open', 'browser_observe', 'browser_act', 'browser_close']);
/** The subset that lives in the project-scoped sandbox. */
const SANDBOX_TOOL_NAMES = new Set(['run_bash', 'git_op', 'read_log', 'terminal_list', 'terminal_close']);
const STATEFUL_TOOL_NAMES = new Set([...SANDBOX_TOOL_NAMES, ...BROWSER_TOOL_NAMES]);
/** Read-only tools that stay unprompted even after a page looked like a prompt injection. */
const READ_ONLY_AFTER_INJECTION = new Set(['browser_observe', 'browser_close', 'read_log', 'terminal_list', 'read_file']);
/** Results of these virtual tools carry the same `[browser-meta]` first line as browser observations. */
const WEB_VIRTUAL_TOOLS = new Set(['web_fetch', 'web_search']);
const IRREVERSIBLE_WARNING = 'This browser action looks irreversible (payment, deletion, subscription…). Check that it is what you asked for.';
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

function realToolName(exposedName: string): string {
  const parts = exposedName.split('__');
  return parts[parts.length - 1] ?? '';
}

function needsProjectId(exposedName: string): boolean {
  return SANDBOX_TOOL_NAMES.has(realToolName(exposedName));
}

function needsConversationId(exposedName: string): boolean {
  return STATEFUL_TOOL_NAMES.has(realToolName(exposedName));
}

/**
 * db.ts round-trips messages through JSON.stringify/parse with no schema
 * enforcement, and every caller hands the result to us as `Llm.MessageParam[]`
 * via a bare type cast — not an actual guarantee about what's in there. Strip
 * anything the message format doesn't define before it reaches `messages.create`,
 * so a stray field (e.g. a frontend-only `id` that leaked into a stored message)
 * gets dropped here instead of surfacing as an opaque 400 from the provider mid-turn.
 */
export function sanitizeHistory(history: Llm.MessageParam[]): Llm.MessageParam[] {
  return history.map(msg => ({
    role: msg.role,
    content: typeof msg.content === 'string' ? msg.content : msg.content.map(sanitizeBlock),
  }));
}

function sanitizeBlock(block: Llm.ContentBlockParam): Llm.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content, is_error: block.is_error };
    default:
      // Unhandled block type (e.g. image) — pass through as-is rather than
      // silently dropping content this app doesn't otherwise deal with.
      return block;
  }
}

/** What a tool call that never finished reports to the model on the next turn. */
export const INTERRUPTED_TOOL_RESULT = 'Interrupted: the turn ended before this tool call finished, so it may or may not have taken effect.';

/** Bookkeeping that lets `runTurn` hand over (and, on failure, repair) the messages produced so far. */
interface TurnTrace {
  messages: Llm.MessageParam[];
  /** How many of `messages` have already been passed to `onMessages` (the history and the user message count as passed). */
  persisted: number;
  /** Results collected for the tool calls of the step in progress. */
  pending: Llm.ToolResultBlockParam[];
}

function flushNew(deps: ConversationDeps, trace: TurnTrace): void {
  if (trace.messages.length <= trace.persisted) return;
  deps.onMessages?.(trace.messages.slice(trace.persisted));
  trace.persisted = trace.messages.length;
}

/** If the turn stopped between a `tool_use` and its results, finish the pair with error results. */
function closeOpenToolCalls(trace: TurnTrace): void {
  const last = trace.messages[trace.messages.length - 1];
  if (!last || last.role !== 'assistant' || typeof last.content === 'string') return;
  const uses = last.content.filter((b): b is Llm.ToolUseBlock => b.type === 'tool_use');
  if (uses.length === 0) return;
  const have = new Set(trace.pending.map(r => r.tool_use_id));
  const missing = uses.filter(u => !have.has(u.id)).map((u): Llm.ToolResultBlockParam => ({
    type: 'tool_result',
    tool_use_id: u.id,
    content: INTERRUPTED_TOOL_RESULT,
    is_error: true,
  }));
  trace.messages.push({ role: 'user', content: [...trace.pending, ...missing] });
  trace.pending = [];
}

/**
 * Runs one user turn to completion: sends the message, and if the model asks to
 * use tools, executes them (through the Approval Gate where required) and
 * feeds the results back — repeating until the model replies with plain text
 * instead of another tool_use. Returns the updated history.
 *
 * Whatever the turn produced is also handed to `deps.onMessages` as it goes, including when the turn is
 * killed or fails: the tools may already have changed things, and the conversation has to know.
 */
export async function runTurn(
  deps: ConversationDeps,
  history: Llm.MessageParam[],
  userContent: Llm.MessageParam['content'],
): Promise<Llm.MessageParam[]> {
  const trace: TurnTrace = { messages: [], persisted: 0, pending: [] };
  try {
    return await runLoop(deps, history, userContent, trace);
  } catch (err) {
    try {
      closeOpenToolCalls(trace);
      flushNew(deps, trace);
    } catch (storeErr) {
      // The original failure is the one worth reporting.
      console.warn(`[turn] could not store the messages of a failed turn: ${(storeErr as Error).message}`);
    }
    throw err;
  }
}

async function runLoop(
  deps: ConversationDeps,
  history: Llm.MessageParam[],
  userContent: Llm.MessageParam['content'],
  trace: TurnTrace,
): Promise<Llm.MessageParam[]> {
  const messages: Llm.MessageParam[] = [...sanitizeHistory(history), { role: 'user', content: userContent }];
  trace.messages = messages;
  trace.persisted = messages.length;
  const virtualByName = new Map((deps.virtualTools ?? []).map(v => [v.definition.name, v]));
  const toolDefs: Llm.Tool[] = [
    ...(deps.tools.toLlmTools() as Llm.Tool[]),
    ...(deps.virtualTools ?? []).map(v => v.definition),
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
    flushNew(deps, trace); // the previous step (reply + tool results, inbox text included) is complete

    // What is sent may be a trimmed copy (old tool outputs stubbed); `messages` itself is never trimmed. Tool outputs in it are already truncated per result.
    const view = deps.contextWindow
      ? trimForContext(messages, Math.floor(deps.contextWindow * TRIM_AT), estimateTokens([], deps.systemPrompt, toolDefs)).messages
      : messages;
    const params: Llm.MessageCreateParamsNonStreaming = {
      model: deps.model,
      max_tokens: deps.maxTokens ?? 4096,
      system: deps.systemPrompt,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      messages: view,
      ...(deps.reasoningEffort ? { reasoning_effort: deps.reasoningEffort } : {}),
    };
    // Lets the kill switch cancel a request that's already in flight, not just the next one.
    const options = { signal: deps.signal };
    const { onTextDelta, onThinkingDelta } = deps;
    let response: Llm.Message;
    if ((onTextDelta || onThinkingDelta) && deps.llm.messages.stream) {
      const stream = deps.llm.messages.stream(params, options);
      stream.on('streamEvent', event => {
        if (event.type !== 'content_block_delta') return;
        if (event.delta.type === 'text_delta' && event.delta.text) onTextDelta?.({ block: event.index, text: event.delta.text });
        else if (event.delta.type === 'thinking_delta' && event.delta.thinking) onThinkingDelta?.({ text: event.delta.thinking });
      });
      response = await stream.finalMessage();
    } else {
      response = await deps.llm.messages.create(params, options);
    }

    messages.push({ role: 'assistant', content: response.content });
    deps.onUsage?.(response.usage);
    const promptTokens = response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
    if (promptTokens > 0) deps.onContext?.({ used: promptTokens, limit: deps.contextWindow });

    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        deps.onAssistantText?.(block.text);
      }
    }

    const toolUses = response.content.filter(
      (b): b is Llm.ToolUseBlock => b.type === 'tool_use',
    );

    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      flushNew(deps, trace);
      return messages;
    }

    const toolResults: Llm.ToolResultBlockParam[] = [];
    trace.pending = toolResults;
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

      // The adapter could not parse the arguments (typically a reply cut off by the output limit). Running the tool with
      // garbage would at best fail inside the server; tell the model what happened instead.
      const rawArgs = (args as { __invalid_arguments?: unknown }).__invalid_arguments;
      if (typeof rawArgs === 'string') {
        const cut = response.cut_off === true ? ' Your reply hit the output limit while writing the call — send less in one call (split the content).' : '';
        const result = { text: `The arguments of ${use.name} were not valid JSON, so nothing was executed.${cut} Call it again with a valid JSON object. Received: ${rawArgs.slice(0, 200)}${rawArgs.length > 200 ? '…' : ''}`, isError: true };
        deps.onToolResult?.(use.name, result.text, result.text, true);
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: result.text, is_error: true });
        continue;
      }

      // Per-domain gate (web_fetch, browser_open): the user allows a DOMAIN once / for this chat / always, like in
      // Antigravity's browser agent. The grant label is `web:<host>`, so it lives in the ordinary grants table.
      const real = realToolName(use.name);
      let approvedHost: string | undefined;
      const domainGated = virtual ? use.name === 'web_fetch' : real === 'browser_open' && deps.webAccess !== undefined;
      if (domainGated) {
        const host = hostOfUrl(args['url']);
        const refuse = (text: string) => {
          deps.onToolResult?.(use.name, text, text, true);
          toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: text, is_error: true });
        };
        if (!host) { refuse(`${use.name} needs "url" to be a full http(s) URL, e.g. https://example.com/page.`); continue; }
        if (virtual) {
          // The server would refuse a private address anyway; do not ask a human to approve what can never run.
          try { assertPublicUrl(String(args['url']).trim()); } catch (err) {
            if (!(err instanceof UrlBlockedError)) throw err;
            refuse(err.message);
            continue;
          }
        }
        // web_fetch of an address that is already in the conversation (user's own, search or fetch result) needs no
        // approval — as in Claude / Gemini. After a suspected injection even those ask. A URL the model composed
        // itself is the exfiltration channel and is approved per domain.
        const inContext = virtual && !injectionWarning && urlIsInContext(String(args['url']), collectContextUrls(messages, { trustUserText: deps.userUrlsTrusted !== false }));
        const domainDecision = inContext
          ? true
          : await deps.confirm(`web:${host}`, { url: String(args['url']), host, tool: real, ...(virtual ? { outsideContext: true } : {}) }, injectionWarning ? { forcePrompt: injectionWarning } : undefined);
        if (deps.signal?.aborted) throw new Error('Turn aborted by user (kill switch)');
        const allowed = typeof domainDecision === 'boolean' ? domainDecision : domainDecision.approved;
        if (!allowed) {
          const reason = typeof domainDecision === 'boolean' ? undefined : domainDecision.reason;
          const text = reason ? `Not executed — ${reason}.` : `Not executed — the user did not allow web access to ${host}.`;
          toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: text, is_error: true });
          continue;
        }
        approvedHost = host;
      }

      // A domain-gated call has just been approved per domain: that IS the approval for opening it.
      const needsApproval = domainGated ? false : virtual ? virtual.requiresApproval === true : deps.tools.requiresApproval(use.name);
      // The domain was just approved by a human; asking again for the same call would be the double prompt.
      const afterInjection = injectionWarning && !READ_ONLY_AFTER_INJECTION.has(real) && !(domainGated && approvedHost) ? injectionWarning : undefined;
      const irreversible = !virtual && real === 'browser_act' && looksDangerous(args) ? IRREVERSIBLE_WARNING : undefined;
      const forcePrompt = virtual?.alwaysAsk ?? afterInjection ?? irreversible;
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
        if (BROWSER_TOOL_NAMES.has(real)) {
          // Hidden args belong to the orchestrator: a model could otherwise widen its own policy, approve a domain
          // itself or allow downloads. Downloads stay blocked (playwright-mcp default).
          const { _policy: _p, _allow_downloads: _d, _approved_host: _a, ...rest } = enrichedArgs;
          enrichedArgs = rest;
          if (deps.browserPolicy || deps.webAccess) {
            enrichedArgs._policy = { ...deps.browserPolicy, ...(deps.webAccess ? { domainGrant: deps.webAccess.grantedHosts() } : {}) };
          }
          if (real === 'browser_open' && approvedHost) enrichedArgs._approved_host = approvedHost;
        }
        result = await deps.tools.call(use.name, enrichedArgs);
      }
      if (virtual ? WEB_VIRTUAL_TOOLS.has(use.name) : BROWSER_TOOL_NAMES.has(real)) {
        const signal = browserInjectionSignal(result.text);
        if (signal.suspected && !injectionWarning) {
          injectionWarning = `A web page in this turn looked like a prompt injection${signal.reasons.length ? ` (${signal.reasons.slice(0, 3).join('; ')})` : ''}. Check that this action is what you asked for.`;
        }
      }
      const isError = result.isError === true;

      // Long outputs are truncated (head + tail) for the model and for storage
      const { truncated } = truncateToolOutput(result.text, deps.maxToolOutputLength);
      deps.onToolResult?.(use.name, result.text, truncated, isError);

      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: truncated,
        is_error: isError,
      });
    }

    messages.push({ role: 'user', content: toolResults });
    trace.pending = [];
  }
}
