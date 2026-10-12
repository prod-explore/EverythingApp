import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations } from '../db.js';
import {
  AUTO_ENABLE_LIMIT, ModelCatalog, normalizeBaseUrl, parseDiscoveredModel, sanitizeFields, sanitizeTags,
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

  it('reads the MindGate extensions: kind, tags, description, supports, tool_schema, status', () => {
    const m = parseDiscoveredModel({
      id: 'coder', kind: 'chat', tags: ['Coder', 'free', 'bad tag!', 'free'], description: 'Writes code', supports: ['tools', 'vision'],
      pricing: { input: 1.5, output: 6 },
    })!;
    assert.equal(m.reported.tags!.includes('free'), true);
    assert.deepEqual(m.reported, {
      kind: 'chat', tags: ['coder', 'free'], description: 'Writes code', supportsImages: true,
    });
    assert.equal('pricing' in m.reported, false, 'the app keeps no prices');
    assert.equal(parseDiscoveredModel({ id: 'a', supports: ['vision'] })!.reported.toolSchemaMode, 'none', 'no "tools" in supports = no tool calls');
    assert.equal(parseDiscoveredModel({ id: 'a', supports: ['tools'], tool_schema: 'flat' })!.reported.toolSchemaMode, 'flat');
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
    assert.equal('pricing' in m.reported, false, 'a non-zero price is not kept');
    assert.equal(m.reported.tags, undefined, 'and does not make a model free');
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
      sanitizeFields({ label: ' L ', kind: 'bogus', tags: ['A', 'b'], toolSchemaMode: 'weird', pricing: { input: 1, output: 2 }, evil: 1, contextLength: 10.7 }),
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
});

describe('ModelCatalog', () => {
  it('a new provider has no models; discovery adds them and layers reported < override', () => {
    const { catalog } = fresh();
    catalog.create({ slug: 'gemini', label: 'Gemini', baseUrl: 'https://g.example', keyOptional: false, flavor: 'gemini' });
    assert.deepEqual(catalog.providerModels('gemini'), []);
    const r = catalog.applyDiscovered('gemini', [{ id: 'gemini-3.5-flash-lite' }, { id: 'brand-new', tags: ['coder'] }]);
    assert.deepEqual([r.count, r.added, r.removed], [2, 2, 0]);

    // nothing is known about a model beyond what the provider reported
    assert.deepEqual(getModelInfo('@gemini/gemini-3.5-flash-lite').tags, []);
    assert.deepEqual(getModelInfo('@gemini/brand-new').tags, ['coder']);
    // thinking models of the gemini dialect get a bigger output floor without any per-model list
    assert.equal(getModelInfo('@gemini/brand-new').minOutputTokens, 16000);

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
    assert.equal(catalog.remove('p'), true);
    assert.equal(isCatalogModel('@p/a'), false);
    assert.equal(catalog.remove('p'), false);
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
