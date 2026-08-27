import { createAndStartContainer, resetContainer, removeContainer } from './docker.js';

const POOL_SIZE = parseInt(process.env['POOL_SIZE'] ?? '2', 10);
const SANDBOX_IMAGE = process.env['SANDBOX_IMAGE'] ?? 'everything-sandbox:latest';

interface PoolEntry {
  id: string;
  claimed: boolean;
  claimedAt: Date | null;
}

const pool: PoolEntry[] = [];

async function spawnContainer(): Promise<void> {
  const name = `everything-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const id = await createAndStartContainer(SANDBOX_IMAGE, name);
  pool.push({ id, claimed: false, claimedAt: null });
  console.log(`[pool] spawned container ${id.slice(0, 12)}`);
}

export async function initPool(): Promise<void> {
  console.log(`[pool] warming ${POOL_SIZE} sandbox container(s)...`);
  await Promise.all(Array.from({ length: POOL_SIZE }, () => spawnContainer()));
  console.log(`[pool] ready`);
}

export function claimContainer(): string {
  const entry = pool.find(e => !e.claimed);
  if (!entry) throw new Error('No available sandbox containers — pool exhausted');
  entry.claimed = true;
  entry.claimedAt = new Date();
  // Refill in background so the pool is warm for the next caller
  spawnContainer().catch(err => console.error('[pool] refill error:', err));
  return entry.id;
}

export async function releaseContainer(containerId: string): Promise<void> {
  const entry = pool.find(e => e.id === containerId);
  if (!entry) {
    console.warn(`[pool] releaseContainer called with unknown id ${containerId.slice(0, 12)}`);
    return;
  }
  try {
    await resetContainer(containerId);
    entry.claimed = false;
    entry.claimedAt = null;
    console.log(`[pool] released ${containerId.slice(0, 12)}`);
  } catch (err) {
    // If reset fails, remove the poisoned container and spawn a fresh one
    console.error(`[pool] reset failed for ${containerId.slice(0, 12)}, replacing:`, err);
    const idx = pool.indexOf(entry);
    if (idx !== -1) pool.splice(idx, 1);
    removeContainer(containerId).catch(() => {});
    spawnContainer().catch(e => console.error('[pool] replacement spawn error:', e));
  }
}

export function getPoolStatus(): { total: number; available: number; claimed: number } {
  const claimed = pool.filter(e => e.claimed).length;
  return { total: pool.length, available: pool.length - claimed, claimed };
}
