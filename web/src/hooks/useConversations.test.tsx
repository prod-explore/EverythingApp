import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ items: [] as { id: string; title: string }[], n: 0 }));

vi.mock('../api', () => ({
  listConversations: vi.fn(async () => ({ conversations: [...db.items] })),
  createConversation: vi.fn(async (o: { title?: string }) => {
    const id = `c${++db.n}`;
    db.items.unshift({ id, title: o.title ?? 'x' });
    return { id };
  }),
  deleteConversation: vi.fn(async (id: string) => {
    db.items = db.items.filter(c => c.id !== id);
  }),
  updateConversation: vi.fn(async () => ({})),
}));

import { useConversations } from './useConversations';

describe('useConversations', () => {
  beforeEach(() => {
    db.items = [];
    db.n = 0;
  });

  it('spawns exactly one chat on first run', async () => {
    const { result } = renderHook(() => useConversations());
    await waitFor(() => expect(result.current.selectedId).toBe('c1'));
    expect(db.items).toHaveLength(1);
  });

  it('deleting the last chat leaves exactly one fresh chat', async () => {
    db.items = [{ id: 'old', title: 'old' }];
    const { result } = renderHook(() => useConversations());
    await waitFor(() => expect(result.current.selectedId).toBe('old'));
    await act(async () => {
      await result.current.deleteConversation('old');
    });
    await waitFor(() => expect(result.current.selectedId).toBe('c1'));
    expect(db.items.map(c => c.id)).toEqual(['c1']);
    expect(result.current.conversations.map(c => c.id)).toEqual(['c1']);
  });

  it('selects the next chat when the open one is deleted', async () => {
    db.items = [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }];
    const { result } = renderHook(() => useConversations());
    await waitFor(() => expect(result.current.selectedId).toBe('a'));
    await act(async () => {
      await result.current.deleteConversation('a');
    });
    await waitFor(() => expect(result.current.selectedId).toBe('b'));
    expect(db.n).toBe(0);
  });
});
