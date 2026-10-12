import type * as Llm from './llm-types.js';
import type { LlmClient } from './llm-loop.js';

/**
 * Context-window management. Three layers, cheapest first:
 *  1. `trimForContext` — a per-request VIEW of the history with old tool outputs replaced by a stub. Nothing stored changes.
 *  2. `summarizeHistory` + `planCompaction` — the older part of a conversation is replaced by a model-written summary
 *     (stored as a `summary` row, see db.ts → loadLlmHistory); the UI still shows every original message.
 *  3. When a provider still refuses ("context too long"), the server compacts once and retries (server.ts).
 *
 * Token counts are estimates (characters / 3.5). The provider's own `usage.input_tokens` replaces them wherever a
 * response has just come back.
 */

const CHARS_PER_TOKEN = 3.5;
const IMAGE_TOKENS = 1200;

/** Compact when the next request would take more than this share of the window. */
export const COMPACT_AT = 0.75;
/** Trim old tool outputs when a request would take more than this share. */
export const TRIM_AT = 0.6;

const textLen = (b: Llm.TextBlockParam | Llm.ImageBlockParam): number => (b.type === 'text' ? b.text.length : IMAGE_TOKENS * CHARS_PER_TOKEN);

function blockChars(b: Llm.ContentBlockParam): number {
  switch (b.type) {
    case 'text':
      return b.text.length;
    case 'image':
      return IMAGE_TOKENS * CHARS_PER_TOKEN;
    case 'thinking':
      return 0; // stored, never sent
    case 'tool_use':
      return b.name.length + JSON.stringify(b.input ?? {}).length + 16;
    case 'tool_result':
      return (typeof b.content === 'string' ? b.content.length : (b.content ?? []).reduce((n, x) => n + textLen(x), 0)) + 16;
  }
}

export function estimateTokens(messages: Llm.MessageParam[], system = '', tools: Llm.Tool[] = []): number {
  let chars = system.length;
  for (const t of tools) chars += t.name.length + (t.description?.length ?? 0) + JSON.stringify(t.input_schema).length;
  for (const m of messages) chars += typeof m.content === 'string' ? m.content.length : m.content.reduce((n, b) => n + blockChars(b), 0) + 8;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ─── 1. trimming old tool outputs ────────────────────────────────────────────

const stub = (chars: number) => `[Output dropped to save context (${chars.toLocaleString('en-US')} characters). Run the tool again if you need it.]`;

/**
 * A copy of `messages` in which tool outputs are replaced by a stub, oldest first, until the estimate fits `targetTokens`.
 * The newest tool-result message — the one the model is about to read — is never touched. Returns the input array
 * itself when nothing needs doing.
 */
export function trimForContext(
  messages: Llm.MessageParam[],
  targetTokens: number,
  overheadTokens = 0,
): { messages: Llm.MessageParam[]; trimmed: number } {
  let total = estimateTokens(messages) + overheadTokens;
  if (total <= targetTokens) return { messages, trimmed: 0 };

  const resultMsgs: number[] = [];
  messages.forEach((m, i) => {
    if (Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result')) resultMsgs.push(i);
  });
  const candidates = resultMsgs.slice(0, -1);
  if (candidates.length === 0) return { messages, trimmed: 0 };

  const out = messages.slice();
  let trimmed = 0;
  for (const i of candidates) {
    if (total <= targetTokens) break;
    const m = out[i]!;
    if (!Array.isArray(m.content)) continue;
    let changed = false;
    const blocks = m.content.map((b): Llm.ContentBlockParam => {
      if (b.type !== 'tool_result') return b;
      const chars = blockChars(b) - 16;
      if (chars <= stub(chars).length + 40) return b; // already tiny
      total -= Math.ceil((chars - stub(chars).length) / CHARS_PER_TOKEN);
      changed = true;
      trimmed++;
      return { type: 'tool_result', tool_use_id: b.tool_use_id, content: stub(chars), is_error: b.is_error };
    });
    if (changed) out[i] = { role: m.role, content: blocks };
  }
  return trimmed > 0 ? { messages: out, trimmed } : { messages, trimmed: 0 };
}

// ─── 2. compaction ───────────────────────────────────────────────────────────

/** A message the user typed (not a tool_result carrier). */
export function isUserTurn(m: { role: string; content: unknown }): boolean {
  if (m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  return Array.isArray(m.content) && m.content.some((b: { type?: string }) => b?.type !== 'tool_result');
}

/**
 * Where to cut: index of the first message that stays verbatim. Everything before it gets summarised.
 * Keeps the last `keepTurns` user turns (fewer while the kept tail would itself be too big). null = nothing sensible to cut.
 */
export function planCompaction(
  rows: Array<{ role: string; content: unknown }>,
  opts: { keepTurns?: number; maxTailTokens?: number } = {},
): number | null {
  const turns: number[] = [];
  rows.forEach((m, i) => { if (isUserTurn(m)) turns.push(i); });
  for (let keep = Math.min(opts.keepTurns ?? 3, turns.length - 1); keep >= 1; keep--) {
    const cut = turns[turns.length - keep]!;
    if (cut < 2) continue;
    const tail = rows.slice(cut) as Llm.MessageParam[];
    if (opts.maxTailTokens === undefined || estimateTokens(tail) <= opts.maxTailTokens || keep === 1) return cut;
  }
  return null;
}

/** Plain-text rendering of messages for the summariser. Tool outputs are clipped hard — the summary needs outcomes, not dumps. */
export function renderTranscript(messages: Llm.MessageParam[], limits: { toolChars?: number; textChars?: number } = {}): string[] {
  const toolChars = limits.toolChars ?? 700;
  const textChars = limits.textChars ?? 5000;
  const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}… [+${s.length - n} chars]`);
  const parts: string[] = [];
  for (const m of messages) {
    const who = m.role === 'user' ? 'User' : 'Assistant';
    if (typeof m.content === 'string') { parts.push(`${who}: ${clip(m.content, textChars)}`); continue; }
    for (const b of m.content) {
      if (b.type === 'text') parts.push(`${who}: ${clip(b.text, textChars)}`);
      else if (b.type === 'image') parts.push(`${who}: [image]`);
      else if (b.type === 'tool_use') parts.push(`Assistant called ${b.name}(${clip(JSON.stringify(b.input ?? {}), 300)})`);
      else if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content : (b.content ?? []).map(x => (x.type === 'text' ? x.text : '[image]')).join('\n');
        parts.push(`Tool ${b.is_error ? 'error' : 'result'}: ${clip(t, toolChars)}`);
      }
    }
  }
  return parts;
}

const SUMMARY_SYSTEM =
  'You compress the earlier part of a conversation so an AI assistant can continue it without the original messages. ' +
  'Write a dense, factual summary in the language the user writes in. Include: what the user wants and any constraints or preferences they stated; ' +
  'decisions made and why; concrete facts found (names, file paths, ids, numbers, commands, URLs — verbatim); what was done and its outcome; ' +
  'what is still open or planned. No greeting, no commentary about the summary itself. Plain text or short bullet lists.';

export interface SummarizeOptions {
  llm: LlmClient;
  model: string;
  messages: Llm.MessageParam[];
  /** The summary this one extends, if the conversation was compacted before. */
  previous?: string | null;
  signal?: AbortSignal;
  /** Characters of transcript per request; longer histories are folded in chunk by chunk. */
  chunkChars?: number;
  maxTokens?: number;
  onUsage?: (u: Llm.Usage) => void;
}

export async function summarizeHistory(o: SummarizeOptions): Promise<string> {
  const limit = o.chunkChars ?? 48_000;
  const parts = renderTranscript(o.messages);
  const chunks: string[] = [];
  let cur = '';
  for (const p of parts) {
    if (cur && cur.length + p.length > limit) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + p;
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0) return o.previous ?? '';

  let summary = o.previous ?? '';
  for (const chunk of chunks) {
    const prompt =
      (summary ? `Summary of the conversation so far:\n${summary}\n\nNext part of the conversation:\n` : 'Conversation to summarise:\n') +
      `${chunk}\n\nWrite the ${summary ? 'updated ' : ''}summary now.`;
    const res = await o.llm.messages.create(
      { model: o.model, max_tokens: o.maxTokens ?? 2000, system: SUMMARY_SYSTEM, messages: [{ role: 'user', content: prompt }] },
      { signal: o.signal },
    );
    o.onUsage?.(res.usage);
    const text = res.content.filter((b): b is Llm.TextBlock => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!text) throw new Error('the model returned an empty summary');
    summary = text;
  }
  return summary;
}

export const SUMMARY_PREFIX = '[Earlier part of this conversation, summarised to save context]\n';

/** Puts the summary in front of the kept messages as part of the first user message (keeps roles alternating). */
export function withSummary(summary: string | null, rows: Llm.MessageParam[]): Llm.MessageParam[] {
  if (!summary) return rows;
  const note: Llm.TextBlockParam = { type: 'text', text: `${SUMMARY_PREFIX}${summary}\n[End of summary — the conversation continues below]` };
  const first = rows[0];
  if (first && first.role === 'user') {
    const blocks = typeof first.content === 'string' ? [{ type: 'text' as const, text: first.content }] : first.content;
    return [{ role: 'user', content: [note, ...blocks] }, ...rows.slice(1)];
  }
  return [{ role: 'user', content: [note] }, ...rows];
}
