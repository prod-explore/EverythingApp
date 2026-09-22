/**
 * Pool unit tests — inline implementation mirrors pool.ts behaviour.
 *
 * We test the sticky per-conversation lease model introduced in Phase 4.
 * Instead of mocking docker.ts (which requires Node ≥ 22.3 mock.module),
 * we embed a self-contained pool implementation that mirrors pool.ts and
 * inject fake docker deps. If you change pool.ts, update this too.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Inline pool implementation (mirrors pool.ts) ─────────────────────────────

interface PoolDeps {
  createAndStartContainer: (image: string, name: string) => Promise<string>;
  resetContainer: (id: string) => Promise<void>;
  removeContainer: (id: string) => Promise<void>;
  ensureConvWorkspace: (containerId: string, convId: string) => Promise<string>;
  pruneConvVolume: (convId: string) => Promise<void>;
}

interface PoolEntry {
  id: string;
  convId: string | null;
  leaseStartedAt: Date | null;
  lastActivityAt: Date;
}

function makePool(deps: PoolDeps, poolSize: number, image: string, idleTimeoutMs = 30_000) {
  const pool: PoolEntry[] = [];

  async function spawnContainer(): Promise<void> {
    const name = `test-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const id = await deps.createAndStartContainer(image, name);
    pool.push({ id, convId: null, leaseStartedAt: null, lastActivityAt: new Date() });
  }

  async function initPool(): Promise<void> {
    await Promise.all(Array.from({ length: poolSize }, () => spawnContainer()));
  }

  async function claimForConversation(convId: string): Promise<{ containerId: string; workspacePath: string; isNew: boolean }> {
    const existing = pool.find(e => e.convId === convId);
    if (existing) {
      existing.lastActivityAt = new Date();
      const wp = await deps.ensureConvWorkspace(existing.id, convId);
      return { containerId: existing.id, workspacePath: wp, isNew: false };
    }
    const free = pool.find(e => e.convId === null);
    if (!free) throw new Error('No available sandbox containers — pool exhausted');
    free.convId = convId;
    free.leaseStartedAt = new Date();
    free.lastActivityAt = new Date();
    const wp = await deps.ensureConvWorkspace(free.id, convId);
    return { containerId: free.id, workspacePath: wp, isNew: true };
  }

  async function releaseConversation(convId: string): Promise<void> {
    const entry = pool.find(e => e.convId === convId);
    if (!entry) return;
    const id = entry.id;
    entry.convId = null;
    entry.leaseStartedAt = null;
    entry.lastActivityAt = new Date();
    try {
      await deps.resetContainer(id);
      await deps.pruneConvVolume(convId);
    } catch {
      const idx = pool.indexOf(entry);
      if (idx !== -1) pool.splice(idx, 1);
      deps.removeContainer(id).catch(() => {});
      spawnContainer().catch(() => {});
    }
  }

  function touchConversation(convId: string): void {
    const entry = pool.find(e => e.convId === convId);
    if (entry) entry.lastActivityAt = new Date();
  }

  function getPoolStatus() {
    const now = Date.now();
    const claimed = pool.filter(e => e.convId !== null);
    return {
      total: pool.length,
      available: pool.length - claimed.length,
      claimed: claimed.length,
      leases: claimed.map(e => ({
        convId: e.convId!,
        containerId: e.id,
        idleSinceMs: now - e.lastActivityAt.getTime(),
      })),
    };
  }

  function isClaimedContainer(containerId: string): boolean {
    return pool.some(e => e.id === containerId && e.convId !== null);
  }

  return { initPool, claimForConversation, releaseConversation, touchConversation, getPoolStatus, isClaimedContainer };
}

// ─── Fake docker deps ─────────────────────────────────────────────────────────

function makeFakeDeps(): PoolDeps {
  let counter = 0;
  return {
    createAndStartContainer: async (_image, _name) => `fake-container-${++counter}`,
    resetContainer: async () => {},
    removeContainer: async () => {},
    ensureConvWorkspace: async (_cid, convId) => `/workspace/${convId}`,
    pruneConvVolume: async () => {},
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Pool — sticky per-conversation leases', async () => {
  const deps = makeFakeDeps();
  const pool = makePool(deps, 2, 'test-image');
  await pool.initPool();

  it('reports correct initial status', () => {
    const s = pool.getPoolStatus();
    assert.equal(s.total, 2);
    assert.equal(s.available, 2);
    assert.equal(s.claimed, 0);
  });

  it('new conversation gets a fresh container (isNew=true)', async () => {
    const r = await pool.claimForConversation('conv-a');
    assert.ok(r.containerId);
    assert.equal(r.isNew, true);
    assert.equal(pool.getPoolStatus().claimed, 1);
  });

  it('same conversation returns the SAME container (sticky)', async () => {
    const r1 = await pool.claimForConversation('conv-sticky');
    const r2 = await pool.claimForConversation('conv-sticky');
    assert.equal(r1.containerId, r2.containerId, 'sticky: same container');
    assert.equal(r2.isNew, false, 'second claim is not new');
    // Claimed count should be 2 (conv-a + conv-sticky), not 3
    assert.equal(pool.getPoolStatus().claimed, 2);
  });

  it('different conversations get DIFFERENT containers', async () => {
    // Pool is now exhausted (2/2). Release one to make room.
    await pool.releaseConversation('conv-a');

    const b = await pool.claimForConversation('conv-b');
    const stickyAgain = await pool.claimForConversation('conv-sticky');
    assert.notEqual(b.containerId, stickyAgain.containerId, 'different convs → different containers');
  });

  it('throws when pool is exhausted (no free containers)', async () => {
    // Both slots taken by conv-b and conv-sticky
    await assert.rejects(
      () => pool.claimForConversation('conv-overflow'),
      /exhausted/,
    );
  });

  it('releasing a conversation returns its container to the pool', async () => {
    const before = pool.getPoolStatus();
    await pool.releaseConversation('conv-b');
    const after = pool.getPoolStatus();
    assert.equal(after.claimed, before.claimed - 1);
    assert.equal(after.available, before.available + 1);
  });

  it('released container is no longer claimed', async () => {
    const r = await pool.claimForConversation('conv-release-test');
    assert.equal(pool.isClaimedContainer(r.containerId), true);
    await pool.releaseConversation('conv-release-test');
    assert.equal(pool.isClaimedContainer(r.containerId), false);
  });

  it('touchConversation does not crash for unknown convId', () => {
    assert.doesNotThrow(() => pool.touchConversation('conv-does-not-exist'));
  });

  it('leases array in getPoolStatus contains correct info', async () => {
    await pool.claimForConversation('conv-status-test');
    const s = pool.getPoolStatus();
    const lease = s.leases.find(l => l.convId === 'conv-status-test');
    assert.ok(lease, 'should have lease entry');
    assert.ok(lease.containerId.startsWith('fake-container-'));
    assert.ok(lease.idleSinceMs >= 0);
  });

  it('reset failure causes poisoned container to be replaced', async () => {
    let removeCalled = false;
    const badDeps: PoolDeps = {
      createAndStartContainer: async () => `replacement-${Date.now()}`,
      resetContainer: async () => { throw new Error('reset failed'); },
      removeContainer: async () => { removeCalled = true; },
      ensureConvWorkspace: async (_cid, convId) => `/workspace/${convId}`,
      pruneConvVolume: async () => {},
    };
    const badPool = makePool(badDeps, 1, 'test-image');
    await badPool.initPool();
    await badPool.claimForConversation('conv-bad-reset');
    await badPool.releaseConversation('conv-bad-reset');
    assert.equal(removeCalled, true, 'poisoned container should be removed');
    // Pool should not crash
    assert.doesNotThrow(() => badPool.getPoolStatus());
  });
});
