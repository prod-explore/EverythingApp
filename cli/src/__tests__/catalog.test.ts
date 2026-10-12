import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations, setSetting, getSetting, createConversation, getConversation } from '../db.js';
import {
  AUTO_ENABLE_LIMIT, ModelCatalog, legacyModelId, normalizeBaseUrl, parseDiscoveredModel, sanitizeFields, sanitizeTags,
} from '../providers/catalog.js';
import { getModelInfo, isCatalogModel, parseModelId, supportsTools } from '../providers/registry.js';

const fresh = () => {
  const db = openDb(':memory:');
  runMigrations(db);
  return { db, catalog: new ModelCatalog(db, {}) };
};

describe('parseDiscoveredModel', () => {
  it('reads the plain OpenAI shape and guesses the kind from the id', () => {
    assert.deepEqual(parseDiscoveredModel({ id: 'gpt-x' }), { id: 'gpt-x', reported: { kind: 'chat' } });
    assert.equal(parseDiscoveredModel({ id: 'whisper-large' })!.reported.kind, 'stt');
    assert.equal(parseDiscoveredModel({ id: 'text-embedding-3' })!.reported.kind, 'embedding');
    assert.equal(parseDiscoveredModel({ id: 'flux-dev' })!.reported.kind, 'image');
    assert.equal(parseDiscoveredModel({ id: 'models/gemini-x' })!.id, 'gemini-x', 'Google prefixes ids with models/');
  });

  it('reads the MindGate extensions: kind, tags, description, supports, status, pricing per million tokens', () => {
    const m = parseDiscoveredModel({
      id: 'coder', kind: 'chat', tags: ['Coder', 'free', 'bad tag!', 'free'], description: 'Writes code', supports: ['tools', 'vision'],
      status: 'asleep', pricing: { input: 1.5, output: 6 },
    })!;
    assert.deepEqual(m.reported, {
      kind: 'chat', tags: ['coder', 'free'], description: 'Writes code', supportsImages: true, status: 'asleep', pricing: { input: 1.5, output: 6 },
    });
    assert.equal(parseDiscoveredModel({ id: 'a', supports: ['vision'] })!.reported.toolSchemaMode, 'none', 'no "tools" in supports = no tool calls');
  });

  it('reads OpenRouter: name, context_length, per-token string prices, modalities, supported_parameters', () => {
    const m = parseDiscoveredModel({
      id: 'meta/llama', name: 'Llama', context_length: 128000, pricing: { prompt: '0.0000002', completion: '0.0000006' },
      architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools', 'temperature'],
    })!;
    assert.equal(m.reported.label, 'Llama');
    assert.equal(m.reported.contextLength, 128000);
    assert.equal(m.reported.supportsImages, true);
    assert.equal(m.reported.toolSchemaMode, undefined);
    assert.ok(Math.abs(m.reported.pricing!.input - 0.2) < 1e-9 && Math.abs(m.reported.pricing!.output - 0.6) < 1e-9);
  });

  it('a model priced at zero is tagged free; an explicit tag list is never overridden', () => {
    assert.deepEqual(parseDiscoveredModel({ id: 'x', pricing: { prompt: '0', completion: '0' } })!.reported.tags, ['free']);
    assert.deepEqual(parseDiscoveredModel({ id: 'x', tags: ['coder'], pricing: { prompt: '0', completion: '0' } })!.reported.tags, ['coder']);
  });

  it('rejects junk entries', () => {
    for (const bad of [null, 'str', 42, {}, { id: '' }, { id: 'has space' }, { id: 'x'.repeat(201) }]) assert.equal(parseDiscoveredModel(bad), null);
  });
});

describe('sanitizers', () => {
  it('sanitizeFields drops unknown keys and malformed values', () => {
    assert.deepEqual(
      sanitizeFields({ label: ' L ', kind: 'bogus', tags: ['A', 'b'], toolSchemaMode: 'weird', pricing: { input: -1, output: 2 }, evil: 1, contextLength: 10.7 }),
      { label: 'L', tags: ['a', 'b'], contextLength: 10 },
    );
    assert.deepEqual(sanitizeFields(null), {});
  });
  it('sanitizeTags limits count and shape', () => {
    assert.equal(sanitizeTags('x'), undefined);
    assert.equal(sanitizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`))!.length, 12);
  });
  it('normalizeBaseUrl accepts http(s) without credentials and trims trailing slashes', () => {
    assert.equal(normalizeBaseUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1');
    assert.equal(normalizeBaseUrl('http://192.168.1.20:1234/v1'), 'http://192.168.1.20:1234/v1');
    for (const bad of ['ftp://x', 'https://u:p@x.example', 'nope', '', 42]) assert.equal(normalizeBaseUrl(bad), null);
  });
});

describe('model ids', () => {
  it('parse canonical ids', () => {
    assert.deepEqual(parseModelId('@or/meta/llama'), { slug: 'or', upstream: 'meta/llama' });
    assert.equal(parseModelId('gpt-4o'), null);
  });

  it('legacyModelId rewrites bare pre-unification ids by rule (no list of names)', () => {
    assert.equal(legacyModelId('gemini-x'), '@gemini/gemini-x');
    assert.equal(legacyModelId('deepseek-y'), '@deepseek/deepseek-y');
    assert.equal(legacyModelId('whatever-local'), '@mindgate/whatever-local', 'everything else was a MindGate model');
    assert.equal(legacyModelId('claude-sonnet-5'), 'claude-sonnet-5', 'Anthropic is gone — left alone');
    assert.equal(legacyModelId('@x/y'), '@x/y');
    assert.equal(legacyModelId(''), '');
  });
});

describe('ModelCatalog', () => {
  it('a new provider has no models; discovery adds them and layers hint < reported < override', () => {
    const { catalog } = fresh();
    catalog.create({ slug: 'gemini', label: 'Gemini', baseUrl: 'https://g.example', keyOptional: false, flavor: 'gemini' });
    assert.deepEqual(catalog.providerModels('gemini'), []);
    const r = catalog.applyDiscovered('gemini', [{ id: 'gemini-3.5-flash-lite' }, { id: 'brand-new', tags: ['coder'] }]);
    assert.deepEqual([r.count, r.added, r.removed], [2, 2, 0]);

    // hint: we know gemini-3.5-flash-lite is free; the provider said nothing about tags
    assert.ok(getModelInfo('@gemini/gemini-3.5-flash-lite').tags.includes('free'));
    assert.deepEqual(getModelInfo('@gemini/brand-new').tags, ['coder']);
    assert.equal(getModelInfo('@gemini/brand-new').pricing, null, 'unknown price stays unknown');

    // user override wins, null clears it again
    catalog.updateModel('@gemini/brand-new', { fields: { tags: ['free', 'vision'] } });
    assert.deepEqual(getModelInfo('@gemini/brand-new').tags, ['free', 'vision']);
    catalog.updateModel('@gemini/brand-new', { fields: { tags: null } });
    assert.deepEqual(getModelInfo('@gemini/brand-new').tags, ['coder']);
  });

  it('refresh keeps hand-added and user-customised models and drops vanished plain ones', () => {
    const { catalog } = fresh();
    catalog.create({ slug: 'p', label: 'P', baseUrl: 'https://p.example', keyOptional: true, flavor: 'generic' });
    catalog.applyDiscovered('p', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    assert.equal(catalog.addManual('p', 'hand'), true);
    assert.equal(catalog.addManual('p', 'hand'), false, 'duplicates are refused');
    catalog.updateModel('@p/b', { fields: { label: 'My B' } });
    const r = catalog.applyDiscovered('p', [{ id: 'a' }]);
    assert.equal(r.removed, 1); // only c
    assert.deepEqual(catalog.providerModels('p').map(m => m.upstream).sort(), ['a', 'b', 'hand']);
    assert.equal(catalog.providerModels('p').find(m => m.upstream === 'b')!.label, 'My B');
  });

  it('a switched-off model stays switched off across refreshes', () => {
    const { catalog } = fresh();
    catalog.create({ slug: 'p', label: 'P', baseUrl: 'https://p.example', keyOptional: true, flavor: 'generic' });
    catalog.applyDiscovered('p', [{ id: 'a' }, { id: 'b' }]);
    catalog.updateModel('@p/a', { enabled: false });
    catalog.applyDiscovered('p', [{ id: 'a' }, { id: 'b' }]);
    assert.deepEqual(catalog.enabledModels().map(m => m.upstream), ['b']);
  });

  it(`providers with more than ${AUTO_ENABLE_LIMIT} models get new ones switched off`, () => {
    const { catalog } = fresh();
    catalog.create({ slug: 'big', label: 'Big', baseUrl: 'https://big.example', keyOptional: true, flavor: 'generic' });
    catalog.applyDiscovered('big', Array.from({ length: AUTO_ENABLE_LIMIT + 1 }, (_, i) => ({ id: `m${i}` })));
    assert.equal(catalog.providerModels('big').length, AUTO_ENABLE_LIMIT + 1);
    assert.equal(catalog.enabledModels().length, 0);
    catalog.updateModel('@big/m3', { enabled: true });
    assert.deepEqual(catalog.enabledModels().map(m => m.upstream), ['m3']);
  });

  it('disabling a provider hides its models; removing it deletes them', () => {
    const { catalog } = fresh();
    catalog.create({ slug: 'p', label: 'P', baseUrl: 'https://p.example', keyOptional: true, flavor: 'generic' });
    catalog.addManual('p', 'a');
    catalog.update('p', { enabled: false });
    assert.equal(catalog.enabledModels().length, 0);
    assert.equal(catalog.providerModels('p').length, 1);
    assert.equal(catalog.remove('p')?.keyRef, 'p');
    assert.equal(isCatalogModel('@p/a'), false);
    assert.equal(catalog.remove('p'), null);
  });

  it('removeModel deletes a single model', () => {
    const { catalog } = fresh();
    catalog.create({ slug: 'p', label: 'P', baseUrl: 'https://p.example', keyOptional: true, flavor: 'generic' });
    catalog.addManual('p', 'a');
    assert.equal(catalog.removeModel('@p/a'), true);
    assert.equal(catalog.removeModel('@p/a'), false);
  });

  it('survives a restart: a new ModelCatalog on the same db sees the same data', () => {
    const { db, catalog } = fresh();
    catalog.create({ slug: 'p', label: 'P', baseUrl: 'https://p.example', keyOptional: true, flavor: 'generic' });
    catalog.addManual('p', 'a', { tags: ['free'] });
    const again = new ModelCatalog(db, {});
    assert.deepEqual(again.enabledModels().map(m => [m.id, m.tags]), [['@p/a', ['free']]]);
  });
});

describe('legacy import (the pre-unification setup)', () => {
  function legacyDb() {
    const db = openDb(':memory:');
    runMigrations(db);
    // what the old code had: a stored Gemini key, an Anthropic key, a custom provider, chats on bare ids
    for (const provider of ['gemini', 'anthropic']) {
      db.prepare(`INSERT INTO provider_keys (provider, salt, iv, tag, ciphertext, last4) VALUES (?, 'AA==', 'AA==', 'AA==', 'AA==', '1234')`).run(provider);
    }
    db.exec(`CREATE TABLE custom_providers (slug TEXT PRIMARY KEY, label TEXT, base_url TEXT, key_optional INTEGER DEFAULT 0, models TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    db.prepare(`INSERT INTO custom_providers (slug, label, base_url, key_optional, models) VALUES ('or', 'OpenRouter', 'https://openrouter.ai/api/v1', 0, ?)`)
      .run(JSON.stringify([{ id: 'llama-4', label: 'Llama 4', pricing: { input: 0.2, output: 0.6 } }]));
    setSetting(db, 'default_model', 'claude-sonnet-5');
    db.prepare(`DELETE FROM settings WHERE key = 'catalog_v1'`).run(); // never imported yet
    return db;
  }

  it('carries over keyed built-in providers and custom providers, rewrites stored ids, drops the Anthropic default', () => {
    const db = legacyDb();
    const gem = createConversation(db, { title: 'a', model: 'gemini-3.5-flash-lite' }).id;
    const flash = createConversation(db, { title: 'b', model: 'flash' }).id;
    const claude = createConversation(db, { title: 'c', model: 'claude-sonnet-5' }).id;
    db.prepare(`INSERT INTO approval_grants (tool_label, scope, subject_type, subject_id) VALUES ('x', 'always', 'model', 'deepseek-chat')`).run();

    const catalog = new ModelCatalog(db, {});

    assert.deepEqual(catalog.list().map(p => p.slug).sort(), ['gemini', 'or']);
    assert.equal(catalog.get('gemini')!.keyRef, 'gemini', 'built-in providers keep their vault row');
    assert.equal(catalog.get('or')!.keyRef, 'custom:or', 'custom providers keep theirs');
    assert.ok(catalog.providerModels('gemini').length > 0, 'seeded so the picker is not empty before the first refresh');
    assert.deepEqual(catalog.providerModels('or').map(m => [m.id, m.pricing?.input]), [['@or/llama-4', 0.2]]);

    assert.equal(getConversation(db, gem)!.model, '@gemini/gemini-3.5-flash-lite');
    assert.equal(getConversation(db, flash)!.model, '@mindgate/flash');
    assert.equal(getConversation(db, claude)!.model, 'claude-sonnet-5', 'Claude ids are left alone — they simply stop resolving');
    assert.equal(getSetting(db, 'default_model'), '', 'a default pointing at a model that no longer exists is cleared');
    assert.equal((db.prepare(`SELECT subject_id AS s FROM approval_grants WHERE subject_type = 'model'`).get() as { s: string }).s, '@deepseek/deepseek-chat');
  });

  it('runs once: later startups change nothing, even if the user deleted the imported providers', () => {
    const db = legacyDb();
    const first = new ModelCatalog(db, {});
    first.remove('or');
    const second = new ModelCatalog(db, {});
    assert.equal(second.get('or'), undefined);
  });

  it('keeps a default that names a model which exists after the import', () => {
    const db = legacyDb();
    setSetting(db, 'default_model', 'gemini-3.5-flash-lite');
    new ModelCatalog(db, {});
    assert.equal(getSetting(db, 'default_model'), '@gemini/gemini-3.5-flash-lite');
  });
});
