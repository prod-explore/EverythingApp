import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations, createConversation, setProviderWarnLimit } from '../db.js';
import { UsageLedger, rangeStart } from '../usage-ledger.js';

function setup(nowIso = '2026-09-18T10:00:00.000Z') {
  const db = openDb(':memory:');
  runMigrations(db);
  let now = new Date(nowIso);
  const ledger = new UsageLedger(db, () => now, {});
  return { db, ledger, setNow: (iso: string) => void (now = new Date(iso)) };
}

const usage = (i: number, o: number, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: 0 });

describe('UsageLedger', () => {
  it('prices per model, including cache reads and the batch discount', () => {
    const { ledger } = setup();
    // sonnet-5: $2 in / $10 out / $0.2 cache read per MTok
    const live = ledger.record({ conversationId: null, provider: 'anthropic', model: 'claude-sonnet-5', usage: usage(1_000_000, 100_000, 500_000) });
    assert.ok(Math.abs(live.costUsd - (2 + 1 + 0.1)) < 1e-9);
    const batch = ledger.record({ conversationId: null, provider: 'anthropic', model: 'claude-sonnet-5', usage: usage(1_000_000, 0), batch: true });
    assert.ok(Math.abs(batch.costUsd - 1) < 1e-9);
  });

  it('flags unknown models as unpriced instead of guessing', () => {
    const { ledger } = setup();
    const r = ledger.record({ conversationId: null, provider: 'anthropic', model: 'claude-mystery-9', usage: usage(1000, 1000) });
    assert.equal(r.pricingKnown, false);
    assert.equal(r.costUsd, 0);
    assert.equal(ledger.report('all').totals.unpricedCalls, 1);
    assert.match(ledger.headline(0), /^≥/);
  });

  it('breaks spend down by provider, model, conversation and day, respecting the timezone offset', () => {
    const { db, ledger, setNow } = setup('2026-09-18T23:30:00.000Z'); // 01:30 on the 19th in UTC+2
    const conv = createConversation(db, { title: 'Chat A' }).id;
    ledger.record({ conversationId: conv, provider: 'deepseek', model: 'deepseek-chat', usage: usage(1_000_000, 0) });
    setNow('2026-09-17T12:00:00.000Z');
    ledger.record({ conversationId: null, provider: 'gemini', model: 'gemini-3.8-flash', usage: usage(1_000_000, 0) });
    setNow('2026-09-19T08:00:00.000Z');

    const r = ledger.report('7d', 120);
    assert.deepEqual(r.byProvider.map(p => p.provider).sort(), ['deepseek', 'gemini']);
    assert.equal(r.byModel.length, 2);
    assert.equal(r.byConversation.find(c => c.conversationId === conv)?.title, 'Chat A');
    assert.deepEqual(r.byDay.map(d => d.day), ['2026-09-17', '2026-09-19'], 'the 23:30 UTC call belongs to the 19th in UTC+2');
    assert.equal(ledger.report('today', 120).totals.calls, 1);
  });

  it('warns once per month when a provider crosses its soft cap, and re-arms when the cap changes', () => {
    const { db, ledger } = setup();
    setProviderWarnLimit(db, 'anthropic', 5);
    const rec = () => ledger.record({ conversationId: null, provider: 'anthropic', model: 'claude-sonnet-5', usage: usage(2_000_000, 0) }); // $4 each
    assert.equal(rec().warning, null); // $4
    const crossed = rec().warning; // $8
    assert.equal(crossed?.provider, 'anthropic');
    assert.equal(crossed?.thresholdUsd, 5);
    assert.equal(rec().warning, null, 'no repeat warning in the same month');
    setProviderWarnLimit(db, 'anthropic', 10);
    assert.ok(rec().warning, 're-armed after the threshold was edited (now $12 ≥ $10)');
  });

  it('rangeStart handles day/month boundaries', () => {
    assert.equal(rangeStart('today', new Date('2026-09-18T23:30:00Z'), 120)!.toISOString(), '2026-09-18T22:00:00.000Z');
    assert.equal(rangeStart('month', new Date('2026-09-18T10:00:00Z'), 0)!.toISOString(), '2026-09-01T00:00:00.000Z');
    assert.equal(rangeStart('all', new Date(), 0), null);
  });
});
