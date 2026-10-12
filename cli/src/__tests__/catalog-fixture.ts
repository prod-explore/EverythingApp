import { openDb, runMigrations } from '../db.js';
import { ModelCatalog } from '../providers/catalog.js';
import { hintsFor } from '../providers/model-hints.js';
import { PROVIDER_PRESETS } from '../providers/registry.js';

/**
 * Fills the module-level catalog snapshot (what `getModelInfo` reads) with the well-known presets and every model
 * we have a hint for — the stand-in for "the user added Gemini, DeepSeek and MindGate". Call once per test file.
 */
export function seedBuiltinCatalog(): ModelCatalog {
  const db = openDb(':memory:');
  runMigrations(db);
  const catalog = new ModelCatalog(db, {});
  for (const p of PROVIDER_PRESETS) {
    if (p.flavor === 'generic') continue;
    catalog.create({ slug: p.slug, label: p.label, baseUrl: p.baseUrl, keyOptional: p.keyOptional, flavor: p.flavor, concurrency: p.concurrency });
    for (const h of hintsFor(p.flavor)) catalog.addManual(p.slug, h.id);
  }
  return catalog;
}
