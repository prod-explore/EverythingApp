import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Page } from 'playwright';
import { BrowserSessionPool, type ContextLauncher } from '../sessionPool.js';

/** A launcher that hands back a fake context/page — no real browser involved. */
function fakeLauncher(closes: string[], id: string): ContextLauncher {
  return {
    async launch() {
      const context = {
        close: async () => {
          closes.push(id);
        },
      } as unknown as BrowserContext;
      const page = {} as unknown as Page;
      return { context, page };
    },
  };
}

function makePool(opts: Partial<{ maxSessions: number; idleTimeoutMs: number }> = {}, closes: string[] = []) {
  return new BrowserSessionPool({
    maxSessions: opts.maxSessions ?? 4,
    idleTimeoutMs: opts.idleTimeoutMs ?? 1_800_000,
    watchdogIntervalMs: 120_000,
    makeLauncher: id => fakeLauncher(closes, id),
  });
}

describe('BrowserSessionPool', () => {
  it('claim() creates a new session and reports isNew: true', async () => {
    const pool = makePool();
    const { session, isNew } = await pool.claim('conv-1');
    assert.equal(isNew, true);
    assert.equal(session.id, 'conv-1');
    pool.stopWatchdog();
  });

  it('claim() is sticky — the same conversationId gets the same session back', async () => {
    const pool = makePool();
    const first = await pool.claim('conv-1');
    const second = await pool.claim('conv-1');
    assert.equal(second.isNew, false);
    assert.equal(second.session, first.session); // same object identity
    pool.stopWatchdog();
  });

  it('different conversationIds get different sessions', async () => {
    const pool = makePool();
    const a = await pool.claim('conv-a');
    const b = await pool.claim('conv-b');
    assert.notEqual(a.session.id, b.session.id);
    assert.equal(pool.status().total, 2);
    pool.stopWatchdog();
  });

  it('refuses a new session past maxSessions, but sticky reuse still works at capacity', async () => {
    const pool = makePool({ maxSessions: 2 });
    await pool.claim('conv-1');
    await pool.claim('conv-2');

    await assert.rejects(() => pool.claim('conv-3'), /session limit reached/i);

    // Existing conversations aren't blocked by the cap.
    const reuse = await pool.claim('conv-1');
    assert.equal(reuse.isNew, false);
    pool.stopWatchdog();
  });

  it('close() removes the session and calls context.close()', async () => {
    const closes: string[] = [];
    const pool = makePool({}, closes);
    await pool.claim('conv-1');

    const closed = await pool.close('conv-1', 'test');
    assert.equal(closed, true);
    assert.deepEqual(closes, ['conv-1']);
    assert.equal(pool.get('conv-1'), undefined);
    pool.stopWatchdog();
  });

  it('close() on an unknown conversationId returns false and does not throw', async () => {
    const pool = makePool();
    const closed = await pool.close('nope', 'test');
    assert.equal(closed, false);
    pool.stopWatchdog();
  });

  it('touch() updates lastActivityAt so an active session is not the one that idles out', async () => {
    const pool = makePool({ idleTimeoutMs: 1000 });
    const { session } = await pool.claim('conv-1');

    // Simulate real idle time having passed without touch().
    session.lastActivityAt = new Date(Date.now() - 5000);
    pool.touch('conv-1');
    assert.ok(Date.now() - session.lastActivityAt.getTime() < 100);
    pool.stopWatchdog();
  });

  it('sweepIdle() closes sessions past idleTimeoutMs and leaves fresh ones open', async () => {
    const closes: string[] = [];
    const pool = makePool({ idleTimeoutMs: 1000 }, closes);
    const stale = await pool.claim('conv-stale');
    const fresh = await pool.claim('conv-fresh');

    stale.session.lastActivityAt = new Date(Date.now() - 10_000); // well past the timeout
    fresh.session.lastActivityAt = new Date(); // just touched

    pool.sweepIdle();
    // close() inside sweepIdle() is fire-and-forget; give its promise a tick to settle.
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(pool.get('conv-stale'), undefined);
    assert.ok(pool.get('conv-fresh'));
    assert.deepEqual(closes, ['conv-stale']);
    pool.stopWatchdog();
  });

  it('status() reports current session count and per-session idle time', async () => {
    const pool = makePool({ maxSessions: 4 });
    await pool.claim('conv-1');
    const status = pool.status();
    assert.equal(status.total, 1);
    assert.equal(status.max, 4);
    assert.equal(status.sessions[0]?.id, 'conv-1');
    assert.ok(status.sessions[0]!.idleSinceMs >= 0);
    pool.stopWatchdog();
  });
});
