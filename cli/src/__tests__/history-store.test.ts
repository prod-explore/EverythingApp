import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHistory, saveHistory, clearHistory } from '../history-store.js';
import type Anthropic from '@anthropic-ai/sdk';

const tmpDir = await mkdtemp(join(tmpdir(), 'everythingapp-history-'));
const path = join(tmpDir, 'history.json');

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('history-store', () => {
  it('loading a nonexistent file returns an empty history instead of throwing', async () => {
    const history = await loadHistory(join(tmpDir, 'does-not-exist.json'));
    assert.deepEqual(history, []);
  });

  it('round-trips messages through save/load', async () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'cześć' },
      { role: 'assistant', content: 'hej!' },
    ];
    await saveHistory(messages, path);
    const loaded = await loadHistory(path);
    assert.deepEqual(loaded, messages);
  });

  it('clearHistory empties a previously-saved file', async () => {
    await saveHistory([{ role: 'user', content: 'coś' }], path);
    await clearHistory(path);
    const loaded = await loadHistory(path);
    assert.deepEqual(loaded, []);
  });
});
