import { describe, expect, it } from 'vitest';
import type { ThreadAssistantMessagePart } from '@assistant-ui/react';
import { foldRawMessages, liveTurnToMessage } from './messages';
import type { RawMessage } from '../types';

const parts = (m: { content: unknown } | undefined) => (m?.content ?? []) as ThreadAssistantMessagePart[];

describe('foldRawMessages', () => {
  it('attaches a tool result to the call that made it and hides the result-only user message', () => {
    const raw: RawMessage[] = [
      { id: 1, role: 'user', content: 'list files' },
      { id: 2, role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'run_bash', input: { command: 'ls' } }] },
      { id: 3, role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt', is_error: false }] },
      { id: 4, role: 'assistant', content: [{ type: 'text', text: 'One file.' }] },
    ];
    const out = foldRawMessages(raw);
    expect(out.map(m => m.role)).toEqual(['user', 'assistant']);
    const call = parts(out[1]).find(p => p.type === 'tool-call');
    expect(call).toMatchObject({ toolCallId: 't1', toolName: 'run_bash', result: 'a.txt', isError: false, argsText: '{"command":"ls"}' });
  });

  it('reads one turn with several tool rounds as a single assistant message, in order', () => {
    const raw: RawMessage[] = [
      { id: 1, role: 'user', content: 'go' },
      { id: 2, role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read_file', input: {} }] },
      { id: 3, role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] },
      { id: 4, role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'read_file', input: {} }] },
      { id: 5, role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'y', is_error: true }] },
      { id: 6, role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    const out = foldRawMessages(raw);
    expect(out).toHaveLength(2);
    const p = parts(out[1]);
    expect(p.map(x => x.type)).toEqual(['tool-call', 'tool-call', 'text']);
    expect(p[1]).toMatchObject({ toolCallId: 'b', result: 'y', isError: true });
  });

  it('keeps a user message that has text next to a tool result', () => {
    const out = foldRawMessages([
      { id: 1, role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }, { type: 'text', text: 'and also this' }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('user');
  });

  it('turns images into data URLs and never returns an empty user message', () => {
    const out = foldRawMessages([
      { id: 1, role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
      { id: 2, role: 'user', content: [] },
    ]);
    expect(out[0]!.content).toEqual([{ type: 'image', image: 'data:image/png;base64,AAAA' }]);
    expect(out[1]!.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('drops empty thinking blocks and keeps real ones as reasoning', () => {
    const out = foldRawMessages([
      { id: 1, role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' }] },
    ]);
    expect(parts(out[0]).map(p => p.type)).toEqual(['reasoning', 'text']);
  });

  it('places a compaction notice before the user message that triggered it', () => {
    const out = foldRawMessages([
      { id: 1, role: 'assistant', content: [{ type: 'text', text: 'earlier' }] },
      { id: 2, role: 'user', content: 'next question' },
      { id: 3, role: 'summary', content: { text: 'Summarised 12 messages', upTo: 1, replaced: 12 } },
    ]);
    expect(out.map(m => m.role)).toEqual(['assistant', 'system', 'user']);
    expect(out[1]!.content).toEqual([{ type: 'text', text: 'Summarised 12 messages' }]);
  });

  it('uses the database id, not the array position, as the message id', () => {
    const out = foldRawMessages([{ id: 41, role: 'user', content: 'hi' }, { id: 42, role: 'assistant', content: 'hello' }]);
    expect(out.map(m => m.id)).toEqual(['41', '42']);
  });
});

describe('liveTurnToMessage', () => {
  it('is null while nothing has arrived', () => {
    expect(liveTurnToMessage([])).toBeNull();
  });

  it('renders text, reasoning and tool calls of the running turn', () => {
    const m = liveTurnToMessage([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'Let me check', streaming: true },
      { type: 'tool', call: { label: 'Running a command', toolName: 'run_bash', result: { truncatedOutput: 'ok', isError: false, wasTruncated: false } } },
      { type: 'tool', call: { label: 'Reading a file' } },
    ])!;
    expect(m).toMatchObject({ id: 'live-turn', role: 'assistant', status: { type: 'running' } });
    const p = parts(m);
    expect(p.map(x => x.type)).toEqual(['reasoning', 'text', 'tool-call', 'tool-call']);
    expect(p[2]).toMatchObject({ toolName: 'run_bash', result: 'ok', isError: false });
    expect(p[3]).toMatchObject({ toolName: 'Reading a file', result: undefined });
  });
});
