import type { ThreadAssistantMessagePart, ThreadMessageLike } from '@assistant-ui/react';
import type { LivePart } from '../hooks/useSSE';
import type { ContentBlock, RawMessage } from '../types';

/**
 * db.ts stores Anthropic's own message shape: a tool call and its result are
 * two separate messages (`assistant` with a `tool_use` block, then `user`
 * with the matching `tool_result` block) — that's how the Anthropic API
 * itself represents a turn. assistant-ui instead wants the result attached
 * directly to the `tool-call` part inside the assistant message that made
 * the call. This fold does that merge, and drops the now-redundant
 * tool-result-only user messages (they carry no content a person typed).
 */
export function foldRawMessages(raw: RawMessage[]): ThreadMessageLike[] {
  const result: ThreadMessageLike[] = [];

  for (let i = 0; i < raw.length; i++) {
    const msg = raw[i];
    const blocks: ContentBlock[] = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content;

    // A user message that is PURELY tool_result blocks isn't a real user
    // turn — it's plumbing already folded onto the preceding assistant
    // message's tool-call parts in the loop below. Skip it here.
    if (msg.role === 'user' && blocks.length > 0 && blocks.every(b => b.type === 'tool_result')) {
      continue;
    }

    if (msg.role === 'user') {
      const text = blocks
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map(b => b.text)
        .join('');
      result.push({ id: `msg-${i}`, role: 'user', content: [{ type: 'text', text }] });
      continue;
    }

    // Assistant message: text/tool_use parts as-is, then look ahead to the
    // immediately following message for this call's tool_result (that's
    // always where db.ts/anthropic-loop.ts put it — one user message per
    // round of tool results, right after the assistant message that
    // requested them).
    const resultsByCallId = new Map<string, { content: string; isError: boolean }>();
    const next = raw[i + 1];
    if (next && next.role === 'user') {
      const nextBlocks: ContentBlock[] = typeof next.content === 'string' ? [] : next.content;
      for (const b of nextBlocks) {
        if (b.type === 'tool_result') {
          resultsByCallId.set(b.tool_use_id, { content: b.content, isError: Boolean(b.is_error) });
        }
      }
    }

    const parts: ThreadAssistantMessagePart[] = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        const res = resultsByCallId.get(block.id);
        parts.push({
          type: 'tool-call',
          toolCallId: block.id,
          toolName: block.name,
          // Tool args are arbitrary JSON from the model — genuinely JSON-safe
          // at runtime (Anthropic's API only ever sends JSON), but our own
          // ContentBlock type declares `input` as Record<string, unknown>,
          // which is looser than the ReadonlyJSONObject this field wants.
          args: block.input as unknown as Extract<ThreadAssistantMessagePart, { type: 'tool-call' }>['args'],
          argsText: JSON.stringify(block.input),
          result: res?.content,
          isError: res?.isError,
        });
      }
    }
    result.push({ id: `msg-${i}`, role: 'assistant', content: parts });
  }

  return result;
}

/**
 * Renders the turn currently in progress (from useSSE's live state) as one
 * more ThreadMessageLike, appended after the persisted history — so the
 * user sees text/tool calls appear as the backend emits them instead of
 * only once the whole turn lands in the database.
 *
 * Tool calls without a real toolCallId yet (the backend doesn't emit one —
 * see useSSE.ts) get a positional placeholder; it never has to be stable
 * across renders because this message is discarded the moment the turn
 * finishes and the authoritative persisted version (with real ids) takes
 * over on the next messages refetch.
 */
export function liveTurnToMessage(parts: LivePart[]): ThreadMessageLike | null {
  if (parts.length === 0) return null;
  const content: ThreadMessageLike['content'] = parts.map((part, index) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    return {
      type: 'tool-call',
      toolCallId: `live-${index}`,
      toolName: part.call.toolName ?? part.call.label,
      args: {},
      argsText: '',
      result: part.call.result?.truncatedOutput,
      isError: part.call.result?.isError,
    };
  });
  return { id: 'live-turn', role: 'assistant', content, status: { type: 'running' } };
}
