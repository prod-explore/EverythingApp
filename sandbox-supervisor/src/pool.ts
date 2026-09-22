import { createAndStartContainer, resetContainer, removeContainer, pruneConvVolume } from './docker.js';

const POOL_SIZE = parseInt(process.env['POOL_SIZE'] ?? '2', 10);
const SANDBOX_IMAGE = process.env['SANDBOX_IMAGE'] ?? 'everything-sandbox:latest';
/** Milliseconds a lease must be idle before the watchdog reclaims it. Default 30 min. */
const IDLE_TIMEOUT_MS = parseInt(process.env['SANDBOX_IDLE_TIMEOUT_MS'] ?? '1800000', 10);
/** How often the watchdog runs. Default 2 min. */
const WATCHDOG_INTERVAL_MS = parseInt(process.env['SANDBOX_WATCHDOG_INTERVAL_MS'] ?? '120000', 10);

// ─── Types ────────────────────────────────────────────────────────────────────

interface PoolEntry {
  /** Docker container ID. */
  id: string;
  /** null = free, string = conversationId that currently holds this container. */
  convId: string | null;
  /** Wall-clock time the current lease started (or the container was last released). */
  leaseStartedAt: Date | null;
  /** Wall-clock time of the last tool execution inside this container. Used by idle watchdog. */
  lastActivityAt: Date;
}

const pool: PoolEntry[] = [];

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function spawnContainer(): Promise<void> {
  const name = `everything-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const id = await createAndStartContainer(SANDBOX_IMAGE, name);
  pool.push({ id, convId: null, leaseStartedAt: null, lastActivityAt: new Date() });
  console.log(`[pool] spawned container ${id.slice(0, 12)}`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function initPool(): Promise<void> {
  console.log(`[pool] warming ${POOL_SIZE} sandbox container(s)...`);
  await Promise.all(Array.from({ length: POOL_SIZE }, () => spawnContainer()));
  startWatchdog();
  console.log(`[pool] ready`);
}

/**
 * Claim a container for a conversation. If the conversation already holds one,
 * the same container is returned (sticky lease). If not, a free container from
 * the pool is assigned and its per-conversation workspace volume is mounted.
 *
 * Throws if the pool is exhausted (no free containers and this convId has no
 * existing lease).
 */
export function claimForConversation(convId: string): { containerId: string; isNew: boolean } {
  // Check if this conversation already holds a container.
  const existing = pool.find(e => e.convId === convId);
  if (existing) {
    existing.lastActivityAt = new Date();
    console.log(`[pool] conv ${convId.slice(0, 8)} reusing container ${existing.id.slice(0, 12)}`);
    return { containerId: existing.id, isNew: false };
  }

  // Assign a free container.
  const free = pool.find(e => e.convId === null);
  if (!free) {
    throw new Error(
      `No available sandbox containers — pool exhausted (size ${POOL_SIZE}). ` +
      `Try again after another conversation finishes.`,
    );
  }

  free.convId = convId;
  free.leaseStartedAt = new Date();
  free.lastActivityAt = new Date();
  console.log(`[pool] conv ${convId.slice(0, 8)} claimed container ${free.id.slice(0, 12)}`);
  return { containerId: free.id, isNew: true };
}

/**
 * Record activity for a conversation's container. Call after every successful
 * tool execution to keep the idle watchdog from reclaiming an active container.
 */
export function touchConversation(convId: string): void {
  const entry = pool.find(e => e.convId === convId);
  if (entry) entry.lastActivityAt = new Date();
}

/**
 * Explicitly release a conversation's container back to the pool.
 * The container's workspace volume is pruned and the container is reset.
 * Callers should use this when the conversation's sandbox session ends (e.g.
 * sandbox toggle turned off). Idle timeout handles the automatic case.
 */
export async function releaseConversation(convId: string): Promise<void> {
  const entry = pool.find(e => e.convId === convId);
  if (!entry) {
    console.warn(`[pool] releaseConversation called for unknown convId ${convId.slice(0, 8)}`);
    return;
  }
  await resetPoolEntry(entry, `explicit release for conv ${convId.slice(0, 8)}`);
}

/** True if this container id is managed by the pool (any state). */
export function isKnownContainer(containerId: string): boolean {
  return pool.some(e => e.id === containerId);
}

/** True if this container id is currently claimed (by any conversation). */
export function isClaimedContainer(containerId: string): boolean {
  return pool.some(e => e.id === containerId && e.convId !== null);
}

export function getPoolStatus(): {
  total: number;
  available: number;
  claimed: number;
  leases: Array<{ convId: string; containerId: string; idleSinceMs: number }>;
} {
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

// ─── Internal reset helper ────────────────────────────────────────────────────

async function resetPoolEntry(entry: PoolEntry, reason: string): Promise<void> {
  const convId = entry.convId;
  console.log(`[pool] releasing container ${entry.id.slice(0, 12)} — ${reason}`);
  entry.convId = null;
  entry.leaseStartedAt = null;
  entry.lastActivityAt = new Date();

  try {
    await resetContainer(entry.id);
    if (convId) {
      pruneConvVolume(convId).catch(() => {
        // Volume prune errors are non-fatal; volume may not exist if container never ran workloads.
      });
    }
  } catch (err) {
    console.error(`[pool] reset failed for ${entry.id.slice(0, 12)}, replacing:`, err);
    const idx = pool.indexOf(entry);
    if (idx !== -1) pool.splice(idx, 1);
    removeContainer(entry.id).catch(() => {});
    if (convId) pruneConvVolume(convId).catch(() => {});
    spawnContainer().catch(e => console.error('[pool] replacement spawn error:', e));
  }
}

// ─── Idle watchdog ────────────────────────────────────────────────────────────

function startWatchdog(): void {
  setInterval(() => {
    const now = Date.now();
    const timedOut = pool.filter(
      e => e.convId !== null && now - e.lastActivityAt.getTime() > IDLE_TIMEOUT_MS,
    );
    for (const entry of timedOut) {
      const idleMin = Math.round((now - entry.lastActivityAt.getTime()) / 60_000);
      resetPoolEntry(
        entry,
        `idle timeout: conv ${entry.convId?.slice(0, 8)} idle ${idleMin}m`,
      ).catch(err => console.error('[pool] watchdog reset error:', err));
    }
  }, WATCHDOG_INTERVAL_MS).unref(); // .unref() so watchdog doesn't prevent clean process exit
}
