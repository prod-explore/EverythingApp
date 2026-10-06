import { createHash, randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, MessageStreamLike } from '../anthropic-loop.js';
import type { ModelInfo } from './registry.js';

/**
 * Adapter for providers that speak the OpenAI chat-completions dialect (Gemini's
 * compatibility endpoint, DeepSeek). The app's canonical message format stays
 * Anthropic-shaped — that is what's persisted and what the tool loop consumes —
 * so this file's whole job is translating *out* to chat-completions and *back*
 * to an Anthropic.Message, per request. Nothing provider-specific ever reaches
 * the database or the loop except through MetaStore.
 */

/** 'generic' = any OpenAI-compatible endpoint added by the user (N5): no provider-specific quirks. */
export type CompatFlavor = 'gemini' | 'deepseek' | 'mindgate' | 'generic';

/**
 * Provider state that has no slot in the Anthropic message shape but that the
 * provider insists on getting back (Gemini 3 thought signatures, DeepSeek
 * reasoning_content during a tool loop). Keyed by tool call id.
 */
export interface MetaStore {
  get(toolCallId: string): Record<string, unknown> | null;
  set(toolCallId: string, meta: Record<string, unknown>): void;
}

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${provider} API error ${status}: ${detail}`);
    this.name = 'ProviderHttpError';
  }
}

export interface OpenAiCompatOptions {
  flavor: CompatFlavor;
  baseUrl: string;
  apiKey: string;
  /** Maps our model id to the upstream one (custom providers: `@slug/x` → `x`). */
  upstreamModel?: (modelId: string) => string;
  meta: MetaStore;
  modelInfo: (modelId: string) => ModelInfo;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Keep retrying transient failures (429/5xx/network) for up to this long in total — for provider peak hours.
   * When set it replaces the `maxRetries` count. The kill-switch signal interrupts the wait at any moment.
   */
  retryBudgetMs?: number;
  /** Longest single pause between attempts. Default 5 min. */
  retryMaxDelayMs?: number;
  /** Called before every wait, so the UI/log can say "provider busy, retrying in …". */
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  provider: string;
  attempt: number;
  status: number | 'network';
  delayMs: number;
  /** Time left before giving up. */
  remainingMs: number;
}

/** Exponential backoff (1 s, 2 s, 4 s …) capped at `maxDelayMs`, with ±20 % jitter; a server `Retry-After` wins over the schedule. */
export function retryDelayMs(attempt: number, retryAfterSec: number | undefined, maxDelayMs: number, rand: () => number = Math.random): number {
  const base = retryAfterSec !== undefined && Number.isFinite(retryAfterSec) && retryAfterSec > 0
    ? retryAfterSec * 1000
    : 1000 * 2 ** Math.min(attempt, 30) * (0.8 + 0.4 * rand());
  return Math.round(Math.min(Math.max(base, 1000), maxDelayMs));
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
function abortableSleep(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    sleep(ms).then(
      () => { signal.removeEventListener('abort', onAbort); resolve(); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * Google documents this literal for histories whose function calls were not
 * produced by Gemini (so no real signature exists) — e.g. a conversation that
 * started on Claude and was switched to Gemini mid-way. Without it Gemini 3
 * rejects the request with a 400 about a missing thought_signature.
 */
const GEMINI_DUMMY_SIGNATURE = 'skip_thought_signature_validator';

// ─── Wire types (only the fields we touch) ───────────────────────────────────

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OaiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  extra_content?: { google?: { thought_signature?: string } };
}

type OaiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OaiToolCall[]; reasoning_content?: string }
  | { role: 'tool'; tool_call_id: string; content: string; name?: string };

interface OaiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OaiResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
        extra_content?: { google?: { thought_signature?: string } };
      }>;
      reasoning_content?: string | null;
    };
  }>;
  usage?: OaiUsage;
}

// ─── Tool name safety ────────────────────────────────────────────────────────

/** Chat-completions APIs cap function names at 64 chars of [A-Za-z0-9_.:-]. MCP-derived names ("server__tool") can exceed that. */
export function safeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  if (cleaned.length <= 64 && cleaned === name) return name;
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8);
  return `${cleaned.slice(0, 55)}_${hash}`;
}

class NameMap {
  private readonly toOriginal = new Map<string, string>();
  safe(original: string): string {
    const s = safeToolName(original);
    this.toOriginal.set(s, original);
    return s;
  }
  original(safe: string): string {
    return this.toOriginal.get(safe) ?? safe;
  }
}

// ─── Schema sanitising ───────────────────────────────────────────────────────

/**
 * MCP servers emit full JSON Schema (`$schema`, `additionalProperties`, …).
 * Gemini's function-declaration schema is an OpenAPI subset and historically
 * rejects keys it doesn't know; it also rejects an OBJECT with an empty
 * `properties` map, which is exactly what every no-argument tool has. Returns
 * undefined when the tool should be declared with no parameters at all.
 */
export function sanitizeSchemaForGemini(schema: unknown): Record<string, unknown> | undefined {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === '$schema' || k === 'additionalProperties') continue;
        out[k] = strip(v);
      }
      return out;
    }
    return node;
  };
  const cleaned = strip(schema) as Record<string, unknown> | undefined;
  if (!cleaned || typeof cleaned !== 'object') return undefined;
  const props = cleaned['properties'];
  if (cleaned['type'] === 'object' && (!props || Object.keys(props as object).length === 0)) return undefined;
  return cleaned;
}

/**
 * 'flat' tool schema mode for small models. Keeps top-level primitive parameters as they are;
 * nested object/array parameters (and anything built from anyOf/oneOf/allOf/$ref) become a string
 * documented as JSON, so the model never has to emit nested JSON inside a tool call. Returns the
 * simplified schema plus the names of the properties that must be JSON-decoded on the way back.
 */
export function flattenToolSchema(schema: unknown): { schema: Record<string, unknown> | undefined; flattened: string[] } {
  if (!schema || typeof schema !== 'object') return { schema: undefined, flattened: [] };
  const root = schema as Record<string, unknown>;
  const props = root['properties'];
  if (root['type'] !== 'object' || !props || typeof props !== 'object' || Object.keys(props).length === 0) {
    return { schema: undefined, flattened: [] };
  }
  const flattened: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const primitive = p['type'] === 'string' || p['type'] === 'number' || p['type'] === 'integer' || p['type'] === 'boolean';
    const composite = 'anyOf' in p || 'oneOf' in p || 'allOf' in p || '$ref' in p;
    if (primitive && !composite) {
      const simple: Record<string, unknown> = { type: p['type'] };
      if (typeof p['description'] === 'string') simple['description'] = p['description'];
      if (Array.isArray(p['enum']) && p['enum'].every(v => typeof v === 'string')) simple['enum'] = p['enum'];
      out[name] = simple;
    } else {
      flattened.push(name);
      const was = p['type'] === 'array' ? 'an array' : p['type'] === 'object' ? 'an object' : 'a JSON value';
      const desc = typeof p['description'] === 'string' ? `${p['description']} ` : '';
      out[name] = { type: 'string', description: `${desc}(Pass ${was} as a JSON-encoded string.)` };
    }
  }
  const required = Array.isArray(root['required']) ? (root['required'] as unknown[]).filter((r): r is string => typeof r === 'string' && r in out) : [];
  return { schema: { type: 'object', properties: out, ...(required.length ? { required } : {}) }, flattened };
}

// ─── Anthropic → chat-completions ────────────────────────────────────────────

function systemText(system: Anthropic.MessageCreateParams['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map(b => b.text).join('\n\n');
}

function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  let text: string;
  if (typeof block.content === 'string') text = block.content;
  else if (Array.isArray(block.content)) {
    text = block.content
      .map(c => (c.type === 'text' ? c.text : `[${c.type} omitted]`))
      .join('\n');
  } else text = '';
  if (block.is_error) text = `Error: ${text || 'tool call failed'}`;
  // Several providers reject an empty tool message outright.
  return text || '(no output)';
}

function describeServerBlock(block: { type: string } & Record<string, unknown>): string | null {
  if (block.type === 'server_tool_use') {
    const input = block['input'] as { query?: string } | undefined;
    return `[searched the web${input?.query ? `: "${input.query}"` : ''}]`;
  }
  if (block.type === 'web_search_tool_result') {
    const content = block['content'];
    if (!Array.isArray(content)) return '[web search returned an error]';
    const items = content
      .slice(0, 5)
      .map(r => {
        const item = r as { title?: string; url?: string };
        return item.title ? `${item.title} (${item.url ?? 'no url'})` : null;
      })
      .filter(Boolean);
    return items.length > 0 ? `[web search results: ${items.join('; ')}]` : '[web search returned no results]';
  }
  return null;
}

/** Index of the last user message that carries real user input (not just tool results) — where the current tool loop began. */
function currentTurnStart(messages: Anthropic.MessageParam[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return i;
    if (m.content.some(b => b.type !== 'tool_result')) return i;
  }
  return 0;
}

function normalizeToolCallId(id: string | undefined | null): string {
  const cleaned = (id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
  // Anthropic requires ids to match ^[a-zA-Z0-9_-]+$ — providers sometimes omit them or use other characters.
  return cleaned || `call_${randomUUID().replace(/-/g, '')}`;
}

export interface TranslateContext {
  flavor: CompatFlavor;
  modelInfo: ModelInfo;
  meta: MetaStore;
  names: NameMap;
  /** Parameters sent as JSON-encoded strings in 'flat' mode: tool name (as sent) → property names. Filled by toChatTools. */
  flattened?: Map<string, Set<string>>;
}

export function toChatMessages(params: Anthropic.MessageCreateParamsNonStreaming, ctx: TranslateContext): OaiMessage[] {
  const out: OaiMessage[] = [];
  const sys = systemText(params.system);
  if (sys) out.push({ role: 'system', content: sys });

  const turnStart = currentTurnStart(params.messages);
  // tool_use id → tool name, so Gemini tool messages can carry the function name.
  const toolNames = new Map<string, string>();

  params.messages.forEach((m, idx) => {
    if (typeof m.content === 'string') {
      if (m.content) out.push({ role: m.role, content: m.content } as OaiMessage);
      return;
    }

    if (m.role === 'user') {
      const toolMessages: OaiMessage[] = [];
      const parts: ContentPart[] = [];
      for (const block of m.content) {
        if (block.type === 'tool_result') {
          const msg: OaiMessage = { role: 'tool', tool_call_id: block.tool_use_id, content: toolResultText(block) };
          if (ctx.flavor === 'gemini') msg.name = ctx.names.safe(toolNames.get(block.tool_use_id) ?? 'tool');
          toolMessages.push(msg);
        } else if (block.type === 'text') {
          if (block.text) parts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          if (!ctx.modelInfo.supportsImages) {
            parts.push({ type: 'text', text: `[image attachment omitted — ${ctx.modelInfo.id} can't read images]` });
          } else if (block.source.type === 'base64') {
            parts.push({ type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } });
          } else if (block.source.type === 'url') {
            parts.push({ type: 'image_url', image_url: { url: block.source.url } });
          }
        } else {
          parts.push({ type: 'text', text: `[${block.type} block omitted]` });
        }
      }
      // Tool messages must directly follow the assistant message that made the calls.
      out.push(...toolMessages);
      if (parts.length > 0) {
        const onlyText = parts.every(p => p.type === 'text');
        out.push({
          role: 'user',
          content: onlyText ? parts.map(p => (p as { text: string }).text).join('\n') : parts,
        });
      }
      return;
    }

    // assistant
    const texts: string[] = [];
    const calls: OaiToolCall[] = [];
    for (const block of m.content) {
      if (block.type === 'text') {
        if (block.text) texts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolNames.set(block.id, block.name);
        calls.push({
          id: block.id,
          type: 'function',
          function: { name: ctx.names.safe(block.name), arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        // Anthropic thinking blocks are signed for Anthropic only — meaningless elsewhere.
      } else {
        const described = describeServerBlock(block as unknown as { type: string } & Record<string, unknown>);
        if (described) texts.push(described);
      }
    }

    const msg: Extract<OaiMessage, { role: 'assistant' }> = { role: 'assistant', content: texts.length ? texts.join('\n') : null };
    if (calls.length > 0) {
      msg.tool_calls = calls;
      const metas = calls.map(c => ctx.meta.get(c.id));

      if (ctx.flavor === 'gemini') {
        let anyReal = false;
        calls.forEach((c, i) => {
          const sig = metas[i]?.['thoughtSignature'];
          if (typeof sig === 'string' && sig) {
            c.extra_content = { google: { thought_signature: sig } };
            anyReal = true;
          }
        });
        // Only the first call of a parallel batch carries a signature in real Gemini output; we only
        // need a stand-in when the message has none at all (history that didn't originate from Gemini).
        if (!anyReal) calls[0]!.extra_content = { google: { thought_signature: GEMINI_DUMMY_SIGNATURE } };
      }

      if (ctx.flavor === 'deepseek' && idx > turnStart) {
        // Thinking mode requires the reasoning to be echoed back while a tool loop is still in
        // progress, and rejects it (or ignores it) on earlier turns — so: current loop only.
        const reasoning = metas.map(x => x?.['reasoningContent']).find(r => typeof r === 'string' && r);
        if (typeof reasoning === 'string') msg.reasoning_content = reasoning;
      }
    }
    if (msg.content !== null || msg.tool_calls) out.push(msg);
  });

  return out;
}

export function toChatTools(
  tools: Anthropic.MessageCreateParams['tools'],
  ctx: TranslateContext,
): Array<{ type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }> {
  const out: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }> = [];
  const mode = ctx.modelInfo.toolSchemaMode ?? 'full';
  if (mode === 'none') return out;
  for (const tool of tools ?? []) {
    // Server tools (web_search_20250305, …) have no input_schema and only exist on Anthropic's side.
    if (!('input_schema' in tool)) continue;
    const safeName = ctx.names.safe(tool.name);
    let parameters: Record<string, unknown> | undefined;
    if (mode === 'flat') {
      const flat = flattenToolSchema(tool.input_schema);
      parameters = flat.schema;
      if (flat.flattened.length > 0) {
        ctx.flattened ??= new Map();
        ctx.flattened.set(safeName, new Set(flat.flattened));
      }
    } else {
      parameters =
        ctx.flavor === 'gemini'
          ? sanitizeSchemaForGemini(tool.input_schema)
          : (tool.input_schema as Record<string, unknown>);
    }
    out.push({
      type: 'function',
      function: {
        name: safeName,
        ...(tool.description ? { description: tool.description } : {}),
        ...(parameters ? { parameters } : {}),
      },
    });
  }
  return out;
}

// ─── chat-completions → Anthropic ────────────────────────────────────────────

export function fromChatResponse(json: OaiResponse, requestedModel: string, ctx: TranslateContext, providerId: string): Anthropic.Message {
  const choice = json.choices?.[0];
  if (!choice?.message) throw new Error(`${providerId} returned no completion choices`);
  const msg = choice.message;

  const content: Anthropic.ContentBlock[] = [];
  const text = Array.isArray(msg.content)
    ? msg.content.map(p => p.text ?? '').join('')
    : (msg.content ?? '');
  if (text) content.push({ type: 'text', text, citations: null } as Anthropic.TextBlock);

  const calls = msg.tool_calls ?? [];
  calls.forEach((tc, i) => {
    const id = normalizeToolCallId(tc.id);
    const rawArgs = tc.function?.arguments ?? '';
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
    } catch {
      // Surfacing the raw string makes the MCP server reject it with a schema error the model can read and retry.
      input = { __invalid_arguments: rawArgs };
    }
    // 'flat' mode: parameters we asked the model to JSON-encode are decoded back to real objects/arrays.
    const encoded = ctx.flattened?.get(tc.function?.name ?? '');
    if (encoded) {
      for (const key of encoded) {
        const v = input[key];
        if (typeof v !== 'string') continue;
        try {
          input[key] = JSON.parse(v);
        } catch {
          /* leave the string: the tool's schema validation will tell the model what is wrong */
        }
      }
    }
    content.push({
      type: 'tool_use',
      id,
      name: ctx.names.original(tc.function?.name ?? ''),
      input,
    } as Anthropic.ToolUseBlock);

    const meta: Record<string, unknown> = {};
    const sig = tc.extra_content?.google?.thought_signature;
    if (ctx.flavor === 'gemini' && sig) meta['thoughtSignature'] = sig;
    // One copy of the reasoning per response, hung off the first call — the replay side scans the whole message.
    if (ctx.flavor === 'deepseek' && i === 0 && msg.reasoning_content) meta['reasoningContent'] = msg.reasoning_content;
    if (Object.keys(meta).length > 0) ctx.meta.set(id, meta);
  });

  const toolUse = content.some(b => b.type === 'tool_use');
  const finish = choice.finish_reason;
  // Gemini's compat layer has been seen returning finish_reason "stop" alongside tool calls; the loop keys off stop_reason.
  const stop_reason: Anthropic.StopReason = toolUse
    ? 'tool_use'
    : finish === 'length'
      ? 'max_tokens'
      : finish === 'content_filter'
        ? 'refusal'
        : 'end_turn';

  const u = json.usage ?? {};
  const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const prompt = u.prompt_tokens ?? 0;

  return {
    id: json.id ?? `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: json.model ?? requestedModel,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(prompt - cached, 0),
      output_tokens: u.completion_tokens ?? 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: cached || null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
  } as unknown as Anthropic.Message;
}

// ─── Client ──────────────────────────────────────────────────────────────────

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/**
 * MindGate is a gateway in front of Ollama and wraps upstream errors in its own 5xx. A deterministic
 * upstream 4xx (e.g. Ollama failing to parse a generated tool call) must NOT be retried as if it were
 * a transient outage, and must read as what it is. Returns the status to treat the response as.
 */
export function effectiveStatus(flavor: CompatFlavor, status: number, body: string): number {
  if (flavor !== 'mindgate' || status < 500) return status;
  const m = /\b(?:error|status)\W{0,3}(4\d\d)\b/i.exec(body) ?? /\b(4\d\d)\s+(?:bad request|unprocessable)/i.exec(body);
  if (m) return Number(m[1]);
  if (TOOL_PARSE_ERROR.test(body)) return 400;
  return status;
}

/** Ollama / llama.cpp messages for a generated tool call that is not valid JSON. */
const TOOL_PARSE_ERROR = /looks like object|can'?t find closing|error parsing tool call|invalid tool call|failed to parse.*tool/i;

function linkSignals(external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(external?.reason ?? new Error('aborted'));
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

export class OpenAiCompatClient implements LlmClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: OpenAiCompatOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  }

  readonly messages = {
    create: async (
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Anthropic.Message> => {
      const info = this.opts.modelInfo(params.model);
      const ctx: TranslateContext = { flavor: this.opts.flavor, modelInfo: info, meta: this.opts.meta, names: new NameMap() };

      const tools = toChatTools(params.tools, ctx);
      const body = {
        model: this.opts.upstreamModel?.(params.model) ?? params.model,
        messages: toChatMessages(params, ctx),
        max_tokens: Math.max(params.max_tokens, info.minOutputTokens ?? 0),
        stream: false,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      };

      try {
        const json = (await this.post('/chat/completions', body, options?.signal)) as OaiResponse;
        return fromChatResponse(json, params.model, ctx, this.opts.flavor);
      } catch (err) {
        // A local model that cannot produce valid tool-call JSON must not kill the whole chat:
        // answer once without tools and say so, instead of surfacing a raw gateway error.
        if (
          this.opts.flavor === 'mindgate' &&
          tools.length > 0 &&
          err instanceof ProviderHttpError &&
          err.status === 400 &&
          TOOL_PARSE_ERROR.test(err.message)
        ) {
          const { tools: _t, tool_choice: _c, ...bare } = body as typeof body & { tool_choice?: string };
          const json = (await this.post('/chat/completions', bare, options?.signal)) as OaiResponse;
          const msg = fromChatResponse(json, params.model, ctx, this.opts.flavor);
          const note = '_(This local model could not produce a valid tool call, so it answered without tools. Pick a larger model for tool use.)_\n\n';
          const first = msg.content.find(b => b.type === 'text') as Anthropic.TextBlock | undefined;
          if (first) first.text = note + first.text;
          else msg.content.unshift({ type: 'text', text: note.trim(), citations: null } as Anthropic.TextBlock);
          return msg;
        }
        throw err;
      }
    },
    stream: (params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): MessageStreamLike => this.stream(params, options),
  };

  /**
   * N2b — real token streaming for OpenAI-compatible providers. Text deltas are emitted as Anthropic-style
   * `content_block_delta` events as they arrive; text, reasoning and `tool_calls` deltas (by index, with
   * arguments split across chunks) are accumulated and the final message goes through the same
   * fromChatResponse() translation as the non-streaming path, so tool calls behave identically.
   * Gemini stays non-streaming: its thought signatures arrive outside the delta format we can trust.
   * Any HTTP error before the stream starts falls back to create() (retries, local-model fallback).
   */
  stream(params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): MessageStreamLike {
    const listeners: Array<(e: Anthropic.MessageStreamEvent) => void> = [];
    const emitText = (text: string) => {
      const event = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as Anthropic.MessageStreamEvent;
      for (const l of listeners) l(event);
    };
    const final = (async () => {
      await Promise.resolve(); // let the caller attach listeners first
      if (this.opts.flavor === 'gemini') return this.messages.create(params, options);
      return this.streamOnce(params, options?.signal, emitText);
    })();
    return {
      on(event: 'streamEvent', listener: (e: Anthropic.MessageStreamEvent) => void) {
        if (event === 'streamEvent') listeners.push(listener);
        return this;
      },
      finalMessage: () => final,
    };
  }

  private async streamOnce(
    params: Anthropic.MessageCreateParamsNonStreaming,
    external: AbortSignal | undefined,
    emitText: (text: string) => void,
  ): Promise<Anthropic.Message> {
    const info = this.opts.modelInfo(params.model);
    const ctx: TranslateContext = { flavor: this.opts.flavor, modelInfo: info, meta: this.opts.meta, names: new NameMap() };
    const tools = toChatTools(params.tools, ctx);
    const body = {
      model: this.opts.upstreamModel?.(params.model) ?? params.model,
      messages: toChatMessages(params, ctx),
      max_tokens: Math.max(params.max_tokens, info.minOutputTokens ?? 0),
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    };
    const { signal, cleanup } = linkSignals(external, this.opts.timeoutMs ?? 180_000);
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal,
      });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !res.body) {
        cleanup();
        return this.messages.create(params, { signal: external });
      }
      // Some servers ignore stream:true and answer with plain JSON — accept that too.
      if (!type.includes('event-stream')) return fromChatResponse((await res.json()) as OaiResponse, params.model, ctx, this.opts.flavor);

      let text = '';
      let reasoning = '';
      let finish: string | null = null;
      let id = '';
      let model = '';
      let usage: OaiResponse['usage'];
      const calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      let buffer = '';
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { done = true; break; }
          let evt: {
            id?: string; model?: string; usage?: OaiResponse['usage'];
            choices?: Array<{ finish_reason?: string | null; delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>;
            error?: { message?: string };
          };
          try { evt = JSON.parse(data); } catch { continue; }
          if (evt.error) throw new ProviderHttpError(this.opts.flavor, 502, this.redact(String(evt.error.message ?? 'stream error')));
          if (evt.id) id = evt.id;
          if (evt.model) model = evt.model;
          if (evt.usage) usage = evt.usage;
          const choice = evt.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finish = choice.finish_reason;
          const d = choice.delta ?? {};
          if (d.reasoning_content) reasoning += d.reasoning_content;
          if (d.content) { text += d.content; emitText(d.content); }
          for (const tc of d.tool_calls ?? []) {
            const i = tc.index ?? calls.length;
            calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) calls[i]!.id = tc.id;
            if (tc.function?.name) calls[i]!.function.name += tc.function.name;
            if (tc.function?.arguments) calls[i]!.function.arguments += tc.function.arguments;
          }
        }
      }
      const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
      const json = {
        id, model: model || body.model,
        choices: [{
          index: 0,
          finish_reason: finish ?? (toolCalls.length ? 'tool_calls' : 'stop'),
          message: {
            role: 'assistant',
            content: text || null,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
        }],
        usage,
      } as unknown as OaiResponse;
      return fromChatResponse(json, params.model, ctx, this.opts.flavor);
    } finally {
      cleanup();
    }
  }

  /** Cheap authenticated call used by "Test key" in Settings. */
  async ping(): Promise<void> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/models`, {
      headers: this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {},
    });
    if (!res.ok) throw new ProviderHttpError(this.opts.flavor, res.status, this.redact((await res.text()).slice(0, 300)));
  }

  private redact(text: string): string {
    return this.opts.apiKey ? text.split(this.opts.apiKey).join('[redacted]') : text;
  }

  private async post(path: string, body: unknown, external?: AbortSignal): Promise<unknown> {
    const budget = this.opts.retryBudgetMs;
    const maxDelay = this.opts.retryMaxDelayMs ?? 5 * 60_000;
    const maxRetries = this.opts.maxRetries ?? 2;
    const startedAt = Date.now();
    /** Decides whether another attempt is allowed; returns the pause, or null to give up. */
    const nextPause = (attempt: number, status: number | 'network', retryAfterSec?: number): number | null => {
      if (external?.aborted) return null;
      if (budget !== undefined) {
        const remaining = budget - (Date.now() - startedAt);
        const delay = retryDelayMs(attempt, retryAfterSec, maxDelay);
        if (remaining <= delay) return null;
        this.opts.onRetry?.({ provider: this.opts.flavor, attempt: attempt + 1, status, delayMs: delay, remainingMs: remaining });
        return delay;
      }
      if (attempt >= maxRetries) return null;
      const delay = retryAfterSec && retryAfterSec > 0 ? Math.min(retryAfterSec, 30) * 1000 : 1000 * 2 ** attempt;
      this.opts.onRetry?.({ provider: this.opts.flavor, attempt: attempt + 1, status, delayMs: delay, remainingMs: 0 });
      return delay;
    };

    for (let attempt = 0; ; attempt++) {
      const { signal, cleanup } = linkSignals(external, this.opts.timeoutMs ?? 180_000);
      try {
        let res: Response;
        try {
          res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}) },
            body: JSON.stringify(body),
            signal,
          });
        } catch (err) {
          // Network failure or our own request timeout — transient only in budget mode (peak hours / flaky link).
          const pause = budget !== undefined ? nextPause(attempt, 'network') : null;
          if (pause === null) throw err;
          cleanup();
          await abortableSleep(this.sleep, pause, external);
          continue;
        }
        if (res.ok) return await res.json();

        const errBody = await res.text();
        const status = effectiveStatus(this.opts.flavor, res.status, errBody);
        if (RETRYABLE.has(status)) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const pause = nextPause(attempt, status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
          if (pause !== null) {
            cleanup();
            await abortableSleep(this.sleep, pause, external);
            continue;
          }
        }
        const gaveUp = budget !== undefined && RETRYABLE.has(status) ? ` (retried for ${Math.round((Date.now() - startedAt) / 60_000)} min, then gave up)` : '';
        throw new ProviderHttpError(this.opts.flavor, status, this.redact(errBody.slice(0, 500)) + gaveUp);
      } finally {
        cleanup();
      }
    }
  }
}
