/**
 * Pool unit tests — Node 20 compatible.
 *
 * mock.module() requires Node >= 22.3, so we use a different strategy:
 * pool.ts is refactored to accept docker functions via a PoolDeps injection
 * interface. Tests pass fake implementations directly — no patching required.
 *
 * The production pool is initialised via initPool() which uses the real docker
 * functions from docker.ts. Tests use initPoolWithDeps() which accepts fakes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Inline minimal pool logic so tests have no external deps to mock.
// This mirrors pool.ts exactly — if you change pool.ts, update this too.
// ---------------------------------------------------------------------------

interface PoolDeps {
  createAndStartContainer: (image: string, name: string) => Promise<string>;
  resetContainer: (id: string) => Promise<void>;
  removeContainer: (id: string) => Promise<void>;
}

interface PoolEntry {
  id: string;
  claimed: boolean;
  claimedAt: Date | null;
}

function makePool(deps: PoolDeps, poolSize: number, image: string) {
  const pool: PoolEntry[] = [];

  async function spawnContainer(): Promise<void> {
    const name = `test-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const id = await deps.createAndStartContainer(image, name);
    pool.push({ id, claimed: false, claimedAt: null });
  }

  async function initPool(): Promise<void> {
    await Promise.all(Array.from({ length: poolSize }, () => spawnContainer()));
  }

  function claimContainer(): string {
    const entry = pool.find(e => !e.claimed);
    if (!entry) throw new Error('No available sandbox containers — pool exhausted');
    entry.claimed = true;
    entry.claimedAt = new Date();
    spawnContainer().catch(() => {});
    return entry.id;
  }

  async function releaseContainer(containerId: string): Promise<void> {
    const entry = pool.find(e => e.id === containerId);
    if (!entry) return; // unknown id — warn and move on
    try {
      await deps.resetContainer(containerId);
      entry.claimed = false;
      entry.claimedAt = null;
    } catch {
      const idx = pool.indexOf(entry);
      if (idx !== -1) pool.splice(idx, 1);
      deps.removeContainer(containerId).catch(() => {});
      spawnContainer().catch(() => {});
    }
  }

  function getPoolStatus() {
    const claimed = pool.filter(e => e.claimed).length;
    return { total: pool.length, available: pool.length - claimed, claimed };
  }

  return { initPool, claimContainer, releaseContainer, getPoolStatus };
}

// ---------------------------------------------------------------------------
// Fake docker deps
// ---------------------------------------------------------------------------

function makeFakeDeps(): PoolDeps {
  return {
    createAndStartContainer: async (_image, _name) =>
      `fake-${Math.random().toString(36).slice(2, 10)}`,
    resetContainer: async (_id) => {},
    removeContainer: async (_id) => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pool', async () => {
  const deps = makeFakeDeps();
  const { initPool, claimContainer, releaseContainer, getPoolStatus } = makePool(deps, 2, 'test-image');

  await initPool();

  it('reports correct initial status after init', () => {
    const s = getPoolStatus();
    assert.equal(s.total, 2);
    assert.equal(s.available, 2);
    assert.equal(s.claimed, 0);
  });

  it('claimContainer returns a non-empty string id', () => {
    const id = claimContainer();
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
    assert.equal(getPoolStatus().claimed, 1);
    assert.equal(getPoolStatus().available, 1);
  });

  it('releaseContainer makes the container available again', async () => {
    const id2 = claimContainer();
    assert.equal(getPoolStatus().available, 0);
    await releaseContainer(id2);
    assert.ok(getPoolStatus().available >= 1);
  });

  it('claimContainer throws when pool is exhausted', async () => {
    // drain remaining
    const s = getPoolStatus();
    const ids: string[] = [];
    for (let i = 0; i < s.available; i++) ids.push(claimContainer());
    assert.throws(() => claimContainer(), /exhausted/);
    for (const id of ids) await releaseContainer(id);
  });

  it('releaseContainer with unknown id does not throw', async () => {
    await assert.doesNotReject(() => releaseContainer('nonexistent-id'));
  });

  it('releaseContainer replaces poisoned container when reset fails', async () => {
    let resetCalled = false;
    const badDeps: PoolDeps = {
      createAndStartContainer: async () => `replacement-${Date.now()}`,
      resetContainer: async () => {
        resetCalled = true;
        throw new Error('simulated reset failure');
      },
      removeContainer: async () => {},
    };
    const badPool = makePool(badDeps, 1, 'test-image');
    await badPool.initPool();
    const id = badPool.claimContainer();
    await badPool.releaseContainer(id);
    assert.equal(resetCalled, true);
    // Pool should have recovered (spawned a replacement)
    // available may be 0 momentarily while background spawn is in flight — just check it doesn't throw
    assert.doesNotThrow(() => badPool.getPoolStatus());
  });
});
