import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApprovals } from './useApprovals';

const approval = (id: string, conversationId: string) => ({ id, conversationId, toolLabel: 'run_bash', args: {}, dangerous: false, createdAt: '2026-10-15T00:00:00Z' });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('useApprovals', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows only this conversation’s approvals, and follows a switch without a stale flash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json({ pending: [approval('1', 'a'), approval('2', 'b')] })));
    const { result, rerender } = renderHook(({ id }) => useApprovals(id), { initialProps: { id: 'a' as string | null } });
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(result.current.pending.map(p => p.id)).toEqual(['1']);
    rerender({ id: 'b' });
    expect(result.current.pending.map(p => p.id)).toEqual(['2']);
    rerender({ id: null });
    expect(result.current.pending).toEqual([]);
  });

  it('polls every 2 s and stops on unmount', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({ pending: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = renderHook(() => useApprovals('a'));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(4000)));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    unmount();
    await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('removes an approval at once when it is answered', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => (String(url).includes('pending') ? json({ pending: [approval('1', 'a')] }) : json({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useApprovals('a'));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(result.current.pending).toHaveLength(1);
    await act(async () => { await result.current.respond('1', true, 'once'); });
    expect(result.current.pending).toEqual([]);
    const call = fetchMock.mock.calls.find(c => String(c[0]).includes('approve'));
    expect(JSON.parse(call![1].body)).toMatchObject({ approved: true });
  });
});
