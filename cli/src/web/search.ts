import type Database from 'better-sqlite3';
import { getSetting, setSetting } from '../db.js';

/**
 * Backends for web_search. Pluggable in Settings → Web; the model sees one tool and never knows which engine answers.
 *  - SearXNG: self-hosted metasearch (the JSON format has to be enabled in its settings.yml).
 *  - Brave Search API: hosted, needs a key (kept in the key vault under BRAVE_VAULT_KEY).
 */

export type SearchBackend = 'none' | 'searxng' | 'brave';
export const BRAVE_VAULT_KEY = 'websearch:brave';
const SETTING_KEY = 'web_search';

export interface WebSearchConfig {
  backend: SearchBackend;
  searxngUrl: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** "2 days ago" and the like, when the engine says it. */
  age?: string;
}

export type Recency = 'day' | 'week' | 'month' | 'year';

export interface SearchRequest {
  query: string;
  count: number;
  recency?: Recency;
  signal?: AbortSignal;
}

export interface Searcher {
  readonly backend: Exclude<SearchBackend, 'none'>;
  search(req: SearchRequest): Promise<SearchHit[]>;
}

export class SearchError extends Error {}

const TIMEOUT_MS = 15_000;

export function normalizeSearxngUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new SearchError('SearXNG URL is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SearchError('SearXNG URL must start with http:// or https://');
  if (u.username || u.password) throw new SearchError('Put no credentials in the SearXNG URL');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export function loadSearchConfig(db: Database.Database, env: NodeJS.ProcessEnv = process.env): WebSearchConfig {
  const raw = getSetting(db, SETTING_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<WebSearchConfig>;
      const backend: SearchBackend = parsed.backend === 'searxng' || parsed.backend === 'brave' ? parsed.backend : 'none';
      return { backend, searxngUrl: typeof parsed.searxngUrl === 'string' ? parsed.searxngUrl : '' };
    } catch {
      // damaged value: fall through to the environment defaults
    }
  }
  // Nothing saved in Settings yet: the operator may have set it up in the environment (docker-compose).
  const envUrl = (env['SEARXNG_URL'] ?? '').trim();
  if (envUrl) return { backend: 'searxng', searxngUrl: envUrl };
  return { backend: 'none', searxngUrl: '' };
}

export function saveSearchConfig(db: Database.Database, cfg: WebSearchConfig): WebSearchConfig {
  const backend: SearchBackend = cfg.backend === 'searxng' || cfg.backend === 'brave' ? cfg.backend : 'none';
  const searxngUrl = normalizeSearxngUrl(cfg.searxngUrl ?? '');
  if (backend === 'searxng' && !searxngUrl) throw new SearchError('Enter the SearXNG URL');
  const clean = { backend, searxngUrl };
  setSetting(db, SETTING_KEY, JSON.stringify(clean));
  return clean;
}

function deadline(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([t, signal]) : t;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function isWebUrl(u: string): boolean {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

async function getJson(url: string, headers: Record<string, string>, signal: AbortSignal, fetchImpl: typeof fetch, who: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers }, signal, redirect: 'error' });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new SearchError(`${who} did not answer in time`);
    throw new SearchError(`Could not reach ${who}: ${e.cause instanceof Error ? e.cause.message : e.message}`);
  }
  if (!res.ok) {
    const hint =
      who === 'SearXNG' && res.status === 403 ? ' — enable the json format in SearXNG (settings.yml: search.formats: [html, json])'
      : who === 'Brave Search' && (res.status === 401 || res.status === 403) ? ' — check the API key'
      : who === 'Brave Search' && res.status === 429 ? ' — rate limit reached'
      : '';
    throw new SearchError(`${who} answered HTTP ${res.status}${hint}`);
  }
  try {
    return await res.json();
  } catch {
    throw new SearchError(`${who} did not return JSON${who === 'SearXNG' ? ' — enable the json format in SearXNG (settings.yml: search.formats: [html, json])' : ''}`);
  }
}

export function createSearxngSearcher(baseUrl: string, fetchImpl: typeof fetch = fetch): Searcher {
  return {
    backend: 'searxng',
    async search({ query, count, recency, signal }) {
      const params = new URLSearchParams({ q: query, format: 'json', safesearch: '0' });
      if (recency) params.set('time_range', recency);
      const body = (await getJson(`${baseUrl}/search?${params}`, {}, deadline(signal), fetchImpl, 'SearXNG')) as { results?: unknown };
      const rows = Array.isArray(body.results) ? (body.results as Array<Record<string, unknown>>) : [];
      const hits: SearchHit[] = [];
      for (const r of rows) {
        const url = str(r['url']);
        if (!isWebUrl(url)) continue;
        hits.push({ title: str(r['title']), url, snippet: str(r['content']), age: str(r['publishedDate']) || undefined });
        if (hits.length >= count) break;
      }
      return hits;
    },
  };
}

const BRAVE_FRESHNESS: Record<Recency, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

export function createBraveSearcher(apiKey: string, fetchImpl: typeof fetch = fetch, endpoint = 'https://api.search.brave.com/res/v1/web/search'): Searcher {
  return {
    backend: 'brave',
    async search({ query, count, recency, signal }) {
      const params = new URLSearchParams({ q: query, count: String(Math.min(count, 20)) });
      if (recency) params.set('freshness', BRAVE_FRESHNESS[recency]);
      const body = (await getJson(`${endpoint}?${params}`, { 'X-Subscription-Token': apiKey }, deadline(signal), fetchImpl, 'Brave Search')) as {
        web?: { results?: unknown };
      };
      const rows = Array.isArray(body.web?.results) ? (body.web!.results as Array<Record<string, unknown>>) : [];
      const hits: SearchHit[] = [];
      for (const r of rows) {
        const url = str(r['url']);
        if (!isWebUrl(url)) continue;
        // Brave marks matches with <strong>; the description is otherwise plain text.
        hits.push({ title: str(r['title']), url, snippet: str(r['description']).replace(/<\/?[a-z][^>]*>/gi, ''), age: str(r['age']) || undefined });
        if (hits.length >= count) break;
      }
      return hits;
    },
  };
}

/** The searcher for the saved configuration, or null when search is switched off or not complete (no URL / no key). */
export function createSearcher(
  cfg: WebSearchConfig,
  braveKey: () => string | null,
  fetchImpl: typeof fetch = fetch,
): Searcher | null {
  if (cfg.backend === 'searxng' && cfg.searxngUrl) return createSearxngSearcher(cfg.searxngUrl, fetchImpl);
  if (cfg.backend === 'brave') {
    const key = braveKey();
    return key ? createBraveSearcher(key, fetchImpl) : null;
  }
  return null;
}
