import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations, setSetting } from '../db.js';
import { DEFAULT_TIER_MODELS, defaultChatModel, resolveTier, setTierModels, tierModels, tierOfModel, tierRank } from '../tiers.js';

const freshDb = () => { const db = openDb(':memory:'); runMigrations(db); return db; };

describe('tiers', () => {
  it('defaults: free is Gemini Flash-Lite, Claude only from cheap upward', () => {
    assert.equal(tierModels(freshDb()).free, 'gemini-3.5-flash-lite');
    assert.ok(tierModels(freshDb()).cheap.startsWith('claude-'));
    assert.ok(tierRank('free') < tierRank('cheap') && tierRank('cheap') < tierRank('standard') && tierRank('standard') < tierRank('strong'));
  });

  it('stored overrides merge over the defaults; a corrupt setting falls back to defaults', () => {
    const db = freshDb();
    setTierModels(db, { cheap: 'deepseek-chat' });
    assert.equal(tierModels(db).cheap, 'deepseek-chat');
    assert.equal(tierModels(db).free, DEFAULT_TIER_MODELS.free);
    setSetting(db, 'tier_models', '{not json');
    assert.deepEqual(tierModels(db), DEFAULT_TIER_MODELS);
  });

  it('tierOfModel maps a model back to its tier, null when unmapped', () => {
    assert.equal(tierOfModel('gemini-3.5-flash-lite', DEFAULT_TIER_MODELS), 'free');
    assert.equal(tierOfModel('claude-opus-5', DEFAULT_TIER_MODELS), 'strong');
    assert.equal(tierOfModel('some-custom-model', DEFAULT_TIER_MODELS), null);
  });

  it('resolveTier: usable model wins; free steps up exactly one tier; nothing escalates further', () => {
    const only = (...ids: string[]) => (id: string) => ids.includes(id);
    assert.deepEqual(resolveTier('free', DEFAULT_TIER_MODELS, only(DEFAULT_TIER_MODELS.free)), { model: DEFAULT_TIER_MODELS.free, tier: 'free' });
    assert.deepEqual(resolveTier('free', DEFAULT_TIER_MODELS, only(DEFAULT_TIER_MODELS.cheap)), { model: DEFAULT_TIER_MODELS.cheap, tier: 'cheap', fellBackFrom: 'free' });
    assert.equal(resolveTier('free', DEFAULT_TIER_MODELS, only(DEFAULT_TIER_MODELS.standard, DEFAULT_TIER_MODELS.strong)), null);
    assert.equal(resolveTier('standard', DEFAULT_TIER_MODELS, only(DEFAULT_TIER_MODELS.strong)), null);
  });

  it('defaultChatModel is the free tier when usable, null otherwise (caller keeps its configured default)', () => {
    assert.equal(defaultChatModel(DEFAULT_TIER_MODELS, id => id === DEFAULT_TIER_MODELS.free), DEFAULT_TIER_MODELS.free);
    assert.equal(defaultChatModel(DEFAULT_TIER_MODELS, () => false), null);
  });
});
