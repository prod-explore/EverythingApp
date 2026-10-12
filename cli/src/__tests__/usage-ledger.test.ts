import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations, createConversation } from '../db.js';
import { UsageLedger, rangeStart } from '../usage-ledger.js';

function setup(nowIso = '2026-09-18T10:00:00.000Z') {
  const db = openDb(':memory:');
  runMigrations(db);
  let now = new Date(nowIso);
  const ledger = new UsageLedger(db, () => now);
  return { db, ledger, setNow: (iso: string) => void (now = new Date(iso)) };
}

const usage = (i: number, o: number, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: 0 });

describe('UsageLedger', () => {
  it('counts tokens per call, cache reads separately, and keeps no prices', () => {
    const { db, ledger } = setup();
    ledger.record({ conversationId: null, provider: 'p', model: '@p/m', usage: usage(1000, 200, 500) });
    ledger.record({ conversationId: null, provider: 'p', model: '@p/m', usage: usage(10, 5) });
    const t = ledger.report('all').totals;
    assert.deepEqual(
      { i: t.inputTokens, o: t.outputTokens, cr: t.cacheReadTokens, calls: t.calls },
      { i: 1010, o: 205, cr: 500, calls: 2 },
    );
    const cols = (db.prepare(`PRAGMA table_info(usage_log)`).all() as Array<{ name: string }>).map(c => c.name);
    assert.ok(!cols.some(c => /cost|pric|batch/.test(c)), `usage_log has no money columns (${cols.join(',')})`);
  });

  it('headline is a token count for today', () => {
    const { ledger } = setup();
    assert.equal(ledger.headline(0), '0 tokens today');
    ledger.record({ conversationId: null, provider: 'p', model: '@p/m', usage: usage(2000, 300) });
    assert.equal(ledger.headline(0), '2.3k tokens today');
  });

  it('breaks usage down by provider, model, conversation and day, respecting the timezone offset', () => {
    const { db, ledger, setNow } = setup('2026-09-18T23:30:00.000Z'); // 01:30 on the 19th in UTC+2
    const conv = createConversation(db, { title: 'Chat A' }).id;
    ledger.record({ conversationId: conv, provider: 'deepseek', model: '@deepseek/deepseek-chat', usage: usage(1_000_000, 0) });
    setNow('2026-09-17T12:00:00.000Z');
    ledger.record({ conversationId: null, provider: 'gemini', model: '@gemini/flash', usage: usage(1_000_000, 0) });
    setNow('2026-09-19T08:00:00.000Z');

    const r = ledger.report('7d', 120);
    assert.deepEqual(r.byProvider.map(p => p.provider).sort(), ['deepseek', 'gemini']);
    assert.equal(r.byModel.length, 2);
    assert.equal(r.byConversation.find(c => c.conversationId === conv)?.title, 'Chat A');
    assert.deepEqual(r.byDay.map(d => d.day), ['2026-09-17', '2026-09-19'], 'the 23:30 UTC call belongs to the 19th in UTC+2');
    assert.equal(ledger.report('today', 120).totals.calls, 1);
  });

  it('rangeStart handles day/month boundaries', () => {
    assert.equal(rangeStart('today', new Date('2026-09-18T23:30:00Z'), 120)!.toISOString(), '2026-09-18T22:00:00.000Z');
    assert.equal(rangeStart('month', new Date('2026-09-18T10:00:00Z'), 0)!.toISOString(), '2026-09-01T00:00:00.000Z');
    assert.equal(rangeStart('all', new Date(), 0), null);
  });
});
