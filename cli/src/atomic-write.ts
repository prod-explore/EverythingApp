import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * Write JSON to `path` durably: write to a sibling temp file first, then
 * rename() over the real path. rename() is atomic on the same filesystem
 * (temp file lives right next to the target, so this always holds), so a
 * crash or SIGKILL mid-write can never leave a truncated/corrupt file at
 * `path` — worst case a stray .tmp file is left behind, and the previous
 * good version of `path` is untouched. Plain writeFile() doesn't have this
 * property: a kill mid-write truncates the real file in place, and both
 * loadHistory() and loadPendingBatches() treat a corrupt file as "start
 * fresh," silently losing everything.
 */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmpPath, path);
}
