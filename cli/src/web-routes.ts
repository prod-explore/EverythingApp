import express from 'express';
import type Database from 'better-sqlite3';
import type { KeyVault } from './providers/key-vault.js';
import {
  BRAVE_VAULT_KEY,
  createBraveSearcher,
  createSearxngSearcher,
  loadSearchConfig,
  normalizeSearxngUrl,
  saveSearchConfig,
  SearchError,
  type SearchBackend,
  type Searcher,
} from './web/search.js';
import { currentSearcher } from './web/tools.js';

/** Settings → Web: which engine answers web_search. The Brave key lives in the key vault, never in the plain settings table. */
export function createWebRoutes(deps: { db: Database.Database; vault: KeyVault; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }) {
  const { db, vault } = deps;
  const env = deps.env ?? process.env;
  const api = express.Router();

  const describe = () => {
    const cfg = loadSearchConfig(db, env);
    const key = vault.hasKey(BRAVE_VAULT_KEY);
    const envKey = !!(env['BRAVE_API_KEY'] ?? '').trim();
    return {
      backend: cfg.backend,
      searxngUrl: cfg.searxngUrl,
      braveKey: { present: key.present, last4: key.last4, fromEnv: !key.present && envKey },
      vaultEnabled: vault.enabled,
      vaultDisabledReason: vault.disabledReason,
      active: currentSearcher({ db, vault, fetchImpl: deps.fetchImpl, env }) !== null,
    };
  };

  api.get('/web-search', (_req, res) => { res.json(describe()); });

  api.put('/web-search', (req, res) => {
    const body = (req.body ?? {}) as { backend?: unknown; searxngUrl?: unknown; braveKey?: unknown };
    const backend: SearchBackend = body.backend === 'searxng' || body.backend === 'brave' ? body.backend : 'none';
    try {
      const searxngUrl = typeof body.searxngUrl === 'string' ? body.searxngUrl : loadSearchConfig(db, env).searxngUrl;
      saveSearchConfig(db, { backend, searxngUrl });
      // braveKey: a string saves it, null removes it, absent/"" leaves it alone.
      if (typeof body.braveKey === 'string' && body.braveKey.trim()) {
        if (!vault.enabled) { res.status(503).json({ error: vault.disabledReason }); return; }
        vault.set(BRAVE_VAULT_KEY, body.braveKey.trim());
      } else if (body.braveKey === null) {
        vault.delete(BRAVE_VAULT_KEY);
      }
      if (backend === 'brave' && !vault.hasKey(BRAVE_VAULT_KEY).present && !(env['BRAVE_API_KEY'] ?? '').trim()) {
        res.status(400).json({ error: 'Enter the Brave Search API key' });
        return;
      }
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    res.json(describe());
  });

  /** Tries a search with the values from the form (unsaved), falling back to what is saved. */
  api.post('/web-search/test', async (req, res) => {
    const body = (req.body ?? {}) as { backend?: unknown; searxngUrl?: unknown; braveKey?: unknown };
    const saved = loadSearchConfig(db, env);
    const backend = body.backend === 'searxng' || body.backend === 'brave' ? body.backend : saved.backend;
    const fetchImpl = deps.fetchImpl ?? fetch;
    let searcher: Searcher | null = null;
    try {
      if (backend === 'searxng') {
        const url = normalizeSearxngUrl(typeof body.searxngUrl === 'string' && body.searxngUrl.trim() ? body.searxngUrl : saved.searxngUrl);
        if (!url) throw new SearchError('Enter the SearXNG URL');
        searcher = createSearxngSearcher(url, fetchImpl);
      } else if (backend === 'brave') {
        let key = typeof body.braveKey === 'string' ? body.braveKey.trim() : '';
        if (!key) {
          const stored = vault.read(BRAVE_VAULT_KEY);
          key = stored.status === 'ok' ? stored.key : (env['BRAVE_API_KEY'] ?? '').trim();
        }
        if (!key) throw new SearchError('Enter the Brave Search API key');
        searcher = createBraveSearcher(key, fetchImpl);
      } else {
        throw new SearchError('Choose a search engine first');
      }
      const hits = await searcher.search({ query: 'test', count: 3 });
      res.json({ ok: true, results: hits.length });
    } catch (err) {
      res.json({ ok: false, error: err instanceof SearchError ? err.message : (err as Error).message });
    }
  });

  return { api };
}
