import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { backgroundModel, generateTitle } from '../background.js';
import { truncateToolOutput } from '../output-truncator.js';
import { openDb, runMigrations } from '../db.js';
import { generateDailySummary } from '../gazeta.js';
import { createGazetaItem } from '../db.js';
import { setSlots } from '../slots.js';
import type { ProviderRouter } from '../providers/router.js';

const usage = { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null };
const reply = (t: string) => ({ id: 'm', content: [{ type: 'text', text: t, citations: null }], model: 'm', role: 'assistant', stop_reason: 'end_turn', stop_sequence: null, type: 'message', usage }) as unknown as Anthropic.Message;

describe('background (free tier) calls', () => {
  it('cleans the generated title and reports usage', async () => {
    let used = 0;
    const bg = { model: 'f', provider: 'gemini', client: { messages: { create: async () => reply('"Fix login redirect bug."\nextra') } } } as any;
    assert.equal(await generateTitle(bg, 'my login redirects wrongly', 'Check the callback URL', () => used++), 'Fix login redirect bug');
    assert.equal(used, 1);
  });

  it('picks the helper slot, else the first usable free model — never a paid one', () => {
    const db = openDb(':memory:'); runMigrations(db);
    const model = (id: string, tags: string[]) => ({ id, tags, kind: 'chat' });
    const router = (models: Array<{ id: string; tags: string[]; kind: string }>, ok: (id: string) => boolean) =>
      ({ chatCandidates: () => models, isAvailable: ok, clientFor: (id: string) => ({ provider: 'x', info: {}, client: {}, id }) }) as unknown as ProviderRouter;
    const paid = model('@p/paid', ['reasoning']);
    const free = model('@p/free', ['free']);
    assert.equal(backgroundModel(db, router([paid], () => true)), null, 'a paid model must not be used for housekeeping');
    assert.equal(backgroundModel(db, router([free], () => false)), null, 'no usable model → null');
    assert.equal(backgroundModel(db, router([paid, free], () => true))?.model, '@p/free');
    setSlots(db, { helper: '@p/paid' });
    assert.equal(backgroundModel(db, router([paid, free], () => true))?.model, '@p/paid', 'an explicit helper slot wins');
  });

  it('digest reports usage and stores the summary', async () => {
    const db = openDb(':memory:'); runMigrations(db);
    createGazetaItem(db, { type: 'report', title: 'R1', description: 'x' });
    let used = 0;
    const id = await generateDailySummary(db, { messages: { create: async () => reply('Digest!') } } as any, 'f', () => used++);
    assert.ok(id); assert.equal(used, 1);
  });

  it('tool output cap defaults to 12k and keeps head and tail', () => {
    const r = truncateToolOutput('a'.repeat(5000) + 'MID' + 'b'.repeat(50_000));
    assert.ok(r.wasTruncated && r.truncated.length < 12_100);
    assert.ok(r.truncated.startsWith('aaaa') && r.truncated.endsWith('bbbb'));
  });
});
