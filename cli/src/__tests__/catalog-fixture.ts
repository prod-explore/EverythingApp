import { openDb, runMigrations } from '../db.js';
import { ModelCatalog, type ModelFields } from '../providers/catalog.js';

/**
 * Fills the module-level catalog snapshot (what `getModelInfo` reads) with a few providers and models whose
 * metadata the adapter tests depend on — vision, tool-schema mode, tags. In production this is data the provider
 * reports or the user sets; nothing here is built into the app. Call once per test file.
 */
export function seedBuiltinCatalog(): ModelCatalog {
  const db = openDb(':memory:');
  runMigrations(db);
  const catalog = new ModelCatalog(db, {});
  const add = (slug: string, label: string, models: Record<string, ModelFields>) => {
    catalog.create({ slug, label, baseUrl: `https://${slug}.example/v1`, keyOptional: false });
    for (const [id, fields] of Object.entries(models)) catalog.addManual(slug, id, fields);
  };
  add('gemini', 'Google Gemini', {
    'gemini-3.5-flash-lite': { tags: ['free'], supportsImages: true },
    'gemini-3.8-flash': { supportsImages: true },
  });
  add('deepseek', 'DeepSeek', {
    'deepseek-chat': {},
    'deepseek-reasoner': { tags: ['reasoning'] },
  });
  add('mindgate', 'MindGate', {
    flash: { tags: ['free'], toolSchemaMode: 'flat' },
  });
  return catalog;
}
