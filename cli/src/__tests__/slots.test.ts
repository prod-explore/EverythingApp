import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations } from '../db.js';
import {
  allowPaidAgents, firstFree, getSlots, isFreeModel, modelsPrompt, resolveSlot, setAllowPaidAgents, setSlots,
} from '../slots.js';
import type { ModelInfo } from '../providers/registry.js';

const m = (id: string, tags: string[] = [], label = id): ModelInfo =>
  ({ id, provider: 'p', upstream: id, label, kind: 'chat', tags, description: '', pricing: null, supportsImages: false });

const FREE_A = m('@p/free-a', ['free']);
const FREE_B = m('@p/free-b', ['free', 'coder']);
const PAID = m('@p/paid', ['reasoning']);
const ALL = [PAID, FREE_A, FREE_B];
const up = () => true;

function db() {
  const d = openDb(':memory:');
  runMigrations(d);
  return d;
}

describe('slots', () => {
  it('start unset; setSlots stores only what it is given', () => {
    const d = db();
    assert.deepEqual(getSlots(d), { chat: '', helper: '', subagent: '', escalation: '' });
    setSlots(d, { helper: '@p/free-b' });
    assert.equal(getSlots(d).helper, '@p/free-b');
    setSlots(d, { escalation: '@p/paid' });
    assert.equal(getSlots(d).helper, '@p/free-b', 'untouched slots stay');
    setSlots(d, { helper: '' });
    assert.equal(getSlots(d).helper, '');
  });

  it('the free tag is the cost marker', () => {
    assert.equal(isFreeModel(FREE_A), true);
    assert.equal(isFreeModel(PAID), false);
    assert.equal(firstFree(ALL, up), '@p/free-a');
    assert.equal(firstFree(ALL, id => id !== '@p/free-a'), '@p/free-b');
    assert.equal(firstFree([PAID], up), null);
  });

  it('chat: explicit > first free > first available > nothing', () => {
    const d = db();
    assert.equal(resolveSlot(d, 'chat', ALL, up), '@p/free-a');
    assert.equal(resolveSlot(d, 'chat', [PAID], up), '@p/paid');
    assert.equal(resolveSlot(d, 'chat', [PAID], () => false), null);
    assert.equal(resolveSlot(d, 'chat', [], up), null);
    setSlots(d, { chat: '@p/paid' });
    assert.equal(resolveSlot(d, 'chat', ALL, up), '@p/paid');
  });

  it('helper never silently becomes a paid model', () => {
    const d = db();
    assert.equal(resolveSlot(d, 'helper', [PAID], up), null);
    assert.equal(resolveSlot(d, 'helper', ALL, up), '@p/free-a');
    setSlots(d, { helper: '@p/free-b' });
    assert.equal(resolveSlot(d, 'helper', ALL, up), '@p/free-b');
    assert.equal(resolveSlot(d, 'helper', ALL, id => id !== '@p/free-b'), '@p/free-a', 'an unusable explicit choice falls back to a free model');
  });

  it('subagent follows helper unless set; escalation is never automatic', () => {
    const d = db();
    assert.equal(resolveSlot(d, 'subagent', ALL, up), '@p/free-a');
    setSlots(d, { subagent: '@p/free-b' });
    assert.equal(resolveSlot(d, 'subagent', ALL, up), '@p/free-b');
    assert.equal(resolveSlot(d, 'escalation', ALL, up), null);
    setSlots(d, { escalation: '@p/paid' });
    assert.equal(resolveSlot(d, 'escalation', ALL, up), '@p/paid');
    assert.equal(resolveSlot(d, 'escalation', ALL, () => false), null);
  });

  it('allow-paid-agents defaults to off', () => {
    const d = db();
    assert.equal(allowPaidAgents(d), false);
    setAllowPaidAgents(d, true);
    assert.equal(allowPaidAgents(d), true);
    setAllowPaidAgents(d, false);
    assert.equal(allowPaidAgents(d), false);
  });
});

describe('modelsPrompt', () => {
  const slots = { subagent: '@p/free-a', escalation: '@p/paid' };

  it('lists ids, tags and slot marks, and explains how to choose', () => {
    const out = modelsPrompt(ALL, slots, { parentIsFree: false, allowPaid: false });
    assert.match(out, /^## Models for agents/);
    assert.match(out, /- @p\/free-a — @p\/free-a; tags: free \[default for agents\]/);
    assert.match(out, /- @p\/paid — @p\/paid; tags: reasoning \[escalation model\]/);
    assert.match(out, /"free"/);
    assert.doesNotMatch(out, /workers must be free too/);
  });

  it('warns a free chat that workers must be free, unless paid agents are allowed', () => {
    assert.match(modelsPrompt(ALL, slots, { parentIsFree: true, allowPaid: false }), /workers must be free too/);
    assert.doesNotMatch(modelsPrompt(ALL, slots, { parentIsFree: true, allowPaid: true }), /workers must be free too/);
  });

  it('is empty with no models and truncates a huge catalog', () => {
    assert.equal(modelsPrompt([], slots, { parentIsFree: false, allowPaid: false }), '');
    const many = Array.from({ length: 100 }, (_, i) => m(`@p/m${i}`));
    const out = modelsPrompt(many, slots, { parentIsFree: false, allowPaid: false });
    assert.match(out, /and 60 more/);
    assert.equal(out.split('\n').filter(l => l.startsWith('- @p/')).length, 40);
  });
});
