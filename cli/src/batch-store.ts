import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface PendingBatch {
  batchId: string;
  customId: string;
  submittedAt: string;
  /** First ~80 chars of the user's message, just so a status list is human-readable. */
  preview: string;
}

const DEFAULT_PATH = join(homedir(), '.everythingapp', 'batches.json');

export function batchesPath(): string {
  return process.env['EVERYTHINGAPP_BATCHES_PATH'] ?? DEFAULT_PATH;
}

export async function loadPendingBatches(path: string = batchesPath()): Promise<PendingBatch[]> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function savePendingBatches(
  batches: PendingBatch[],
  path: string = batchesPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(batches, null, 2), 'utf-8');
}
