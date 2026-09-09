import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { writeJsonAtomic } from './atomic-write.js';

const DEFAULT_PATH = join(homedir(), '.everythingapp', 'history.json');

export function historyPath(): string {
  return process.env['EVERYTHINGAPP_HISTORY_PATH'] ?? DEFAULT_PATH;
}

export async function loadHistory(path: string = historyPath()): Promise<Anthropic.MessageParam[]> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Missing or corrupt file — start fresh rather than crash the CLI over it.
    return [];
  }
}

export async function saveHistory(
  messages: Anthropic.MessageParam[],
  path: string = historyPath(),
): Promise<void> {
  await writeJsonAtomic(path, messages);
}

export async function clearHistory(path: string = historyPath()): Promise<void> {
  await saveHistory([], path);
}
