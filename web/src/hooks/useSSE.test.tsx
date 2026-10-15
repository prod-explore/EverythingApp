import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_STATE, liveTurnReducer, useSSE, type LiveTurnAction, type LiveTurnState } from './useSSE';

const run = (actions: LiveTurnAction[], from: LiveTurnState = INITIAL_STATE) => actions.reduce(liveTurnReducer, from);

describe('liveTurnReducer', () => {
  it('streams text into one part and replaces it with the complete block', () => {
    const s = run([
      { type: 'start' },
      { type: 'text_delta', block: 0, text: 'Hel' },
      { type: 'text_delta', block: 0, text: 'lo' },
    ]);
    expect(s.running).toBe(true);
    expect(s.parts).toEqual([{ type: 'text', text: 'Hello', block: 0, streaming: true }]);
    const done = liveTurnReducer(s, { type: 'text', text: 'Hello!' });
    expect(done.parts).toEqual([{ type: 'text', text: 'Hello!' }]);
  });

  it('appends a complete block when no partial one exists (provider without streaming, or a reconnect)', () => {
    const s = run([{ type: 'start' }, { type: 'text', text: 'whole' }]);
    expect(s.parts).toEqual([{ type: 'text', text: 'whole' }]);
  });

  it('starts a new text part for a new block', () => {
    const s = run([{ type: 'start' }, { type: 'text_delta', block: 0, text: 'a' }, { type: 'tool_use', label: 'x' }, { type: 'text_delta', block: 1, text: 'b' }]);
    expect(s.parts.map(p => p.type)).toEqual(['text', 'tool', 'text']);
  });

  it('merges consecutive thinking deltas', () => {
    const s = run([{ type: 'start' }, { type: 'thinking_delta', text: 'a' }, { type: 'thinking_delta', text: 'b' }]);
    expect(s.parts).toEqual([{ type: 'reasoning', text: 'ab' }]);
  });

  it('attaches each tool result to the oldest call still waiting for one', () => {
    const s = run([
      { type: 'start' },
      { type: 'tool_use', label: 'first' },
      { type: 'tool_use', label: 'second' },
      { type: 'tool_result', toolName: 'run_bash', truncatedOutput: 'one', isError: false, wasTruncated: false },
      { type: 'tool_result', toolName: 'read_file', truncatedOutput: 'two', isError: true, wasTruncated: true },
    ]);
    expect(s.parts).toMatchObject([
      { type: 'tool', call: { label: 'first', toolName: 'run_bash', result: { truncatedOutput: 'one', isError: false } } },
      { type: 'tool', call: { label: 'second', toolName: 'read_file', result: { truncatedOutput: 'two', isError: true, wasTruncated: true } } },
    ]);
  });

  it('ignores a tool result with no call waiting', () => {
    const before = run([{ type: 'start' }]);
    expect(liveTurnReducer(before, { type: 'tool_result', toolName: 'x', truncatedOutput: '', isError: false, wasTruncated: false })).toBe(before);
  });

  it('clears the live parts when a turn finishes, so the persisted copy is not shown twice', () => {
    const s = run([{ type: 'start' }, { type: 'text', text: 'answer' }, { type: 'finish' }]);
    expect(s).toMatchObject({ running: false, parts: [], finishedCount: 1, error: undefined });
  });

  it('keeps the error and its kind after a failed turn', () => {
    const s = run([{ type: 'start' }, { type: 'finish', error: 'rate limited', kind: 'rate_limited', detail: '429' }]);
    expect(s).toMatchObject({ running: false, error: 'rate limited', errorKind: 'rate_limited', errorDetail: '429' });
  });

  it('keeps the context size and conversation state across turns, and counts compactions', () => {
    const s = run([{ type: 'context', used: 100, limit: 1000 }, { type: 'compacted' }, { type: 'start' }]);
    expect(s.context).toEqual({ used: 100, limit: 1000 });
    expect(s.compactedCount).toBe(1);
  });

  it('a clear forgets the turn but not the counters consumers watch', () => {
    const s = run([{ type: 'start' }, { type: 'finish' }, { type: 'compacted' }, { type: 'clear' }]);
    expect(s).toMatchObject({ running: false, parts: [], finishedCount: 1, compactedCount: 1 });
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  onerror: (() => void) | null = null;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data: unknown = {}) {
    for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent);
  }
}

describe('useSSE', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not connect without a conversation', () => {
    renderHook(() => useSSE(null));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('connects to the conversation stream without any credential in the URL', () => {
    renderHook(() => useSSE('c1'));
    expect(FakeEventSource.instances[0]!.url).toBe('/api/conversations/c1/stream');
  });

  it('turns server events into live state', () => {
    const { result } = renderHook(() => useSSE('c1'));
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.emit('turn:start');
      es.emit('turn:text_delta', { block: 0, text: 'Hi' });
    });
    expect(result.current.running).toBe(true);
    expect(result.current.parts).toMatchObject([{ type: 'text', text: 'Hi' }]);
    act(() => es.emit('turn:error', { error: 'boom', kind: 'other' }));
    expect(result.current).toMatchObject({ running: false, error: 'boom', finishedCount: 1 });
  });

  it('hands side events to the callback', () => {
    const seen: Array<[string, unknown]> = [];
    renderHook(() => useSSE('c1', (e, d) => seen.push([e, d])));
    act(() => FakeEventSource.instances[0]!.emit('gazeta:new', { id: 7 }));
    expect(seen).toEqual([['gazeta:new', { id: 7 }]]);
  });

  it('reconnects 2 s after the connection drops, and stops after unmount', () => {
    const { unmount } = renderHook(() => useSSE('c1'));
    FakeEventSource.instances[0]!.onerror?.();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(2000));
    expect(FakeEventSource.instances).toHaveLength(2);
    unmount();
    expect(FakeEventSource.instances[1]!.closed).toBe(true);
    FakeEventSource.instances[1]!.onerror?.();
    act(() => void vi.advanceTimersByTime(5000));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('forgets the previous conversation when it switches', () => {
    const { result, rerender } = renderHook(({ id }) => useSSE(id), { initialProps: { id: 'a' } });
    act(() => {
      FakeEventSource.instances[0]!.emit('turn:start');
      FakeEventSource.instances[0]!.emit('turn:text', { text: 'from a' });
    });
    expect(result.current.parts).toHaveLength(1);
    rerender({ id: 'b' });
    expect(result.current).toMatchObject({ running: false, parts: [] });
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances[1]!.url).toBe('/api/conversations/b/stream');
  });
});
