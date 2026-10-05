import { z } from 'zod';

/**
 * Domain policy (allowlist / denylist, glob-style) and JavaScript policy for the browser.
 *
 * Two layers feed the effective policy:
 *   1. the operator's env (BROWSER_DOMAIN_ALLOW / BROWSER_DOMAIN_DENY / BROWSER_JS_POLICY),
 *   2. a per-call / per-session override the ORCHESTRATOR passes as the hidden `_policy` arg
 *      (the project's policy; never trusted from the model — the cli sets/strips it).
 * Layers can only tighten: denylists are unioned, every non-empty allowlist must match, and the
 * strictest JS policy wins. The private-network SSRF guard (urlSafety.ts) is separate and always on.
 *
 * Pattern syntax (host only — scheme, port and path in a pattern are ignored):
 *   example.com        exactly example.com
 *   *.example.com      any subdomain of example.com, any depth (NOT example.com itself)
 *   shop-*.example.com `*` elsewhere matches within one label
 *   *                  everything
 */

export const JS_POLICIES = ['disabled', 'review', 'allowed'] as const;
export type JsPolicy = (typeof JS_POLICIES)[number];

export interface PolicyOverride {
  domainAllow?: string[];
  domainDeny?: string[];
  js?: JsPolicy;
}

export interface EffectivePolicy {
  /** Each non-empty layer must match for a top-level navigation to be allowed. */
  allowLayers: string[][];
  /** Union of all denylists — matched against every request. */
  deny: string[];
  js: JsPolicy;
}

/** Zod schema for the hidden `_policy` tool argument. */
export const policyOverrideSchema = z
  .object({
    domainAllow: z.array(z.string()).optional(),
    domainDeny: z.array(z.string()).optional(),
    js: z.enum(JS_POLICIES).optional(),
  })
  .strip();

/** Schemes the browser must never load (on top of the http/https-only SSRF guard). */
const BLOCKED_SCHEMES = new Set([
  'chrome:',
  'chrome-extension:',
  'chrome-untrusted:',
  'chrome-search:',
  'devtools:',
  'file:',
  'filesystem:',
  'view-source:',
  'javascript:',
  'ftp:',
  'ws:',
  'wss:',
]);

export function isBlockedScheme(url: string): boolean {
  const m = /^\s*([a-z][a-z0-9+.-]*:)/i.exec(url);
  if (!m) return false;
  return BLOCKED_SCHEMES.has(m[1]!.toLowerCase());
}

/** Lower-cases, strips scheme/path/port/trailing dot and converts IDN to punycode. Returns null for junk. */
export function normalizeHostPattern(raw: string): string | null {
  let p = raw.trim().toLowerCase();
  if (!p) return null;
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  p = p.replace(/[/?#].*$/, ''); // path/query
  p = p.replace(/^[^@]*@/, ''); // userinfo
  if (!p.startsWith('[')) p = p.replace(/:\d*$/, ''); // port
  p = p.replace(/\.$/, '');
  if (!p) return null;
  if (p === '*') return p;
  // Punycode the non-wildcard labels (WHATWG URL does IDNA for us).
  const labels = p.split('.').map(label => {
    if (label.includes('*') || /^[a-z0-9-]*$/.test(label)) return label;
    try {
      return new URL(`http://${label}.invalid`).hostname.slice(0, -'.invalid'.length);
    } catch {
      return label;
    }
  });
  if (labels.some(l => l === '')) return null;
  return labels.join('.');
}

export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h;
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = normalizeHost(host);
  const p = normalizeHostPattern(pattern);
  if (!h || !p) return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const rest = p.slice(2);
    // Leading "*." = one or more whole labels; the remainder may itself contain within-label wildcards.
    const restRe = escapeRe(rest).replace(/\*/g, '[^.]*');
    return new RegExp(`^(?:[^.]+\\.)+${restRe}$`).test(h);
  }
  if (!p.includes('*')) return h === p;
  return new RegExp(`^${escapeRe(p).replace(/\*/g, '[^.]*')}$`).test(h);
}

export function hostMatchesAny(host: string, patterns: readonly string[]): boolean {
  return patterns.some(p => hostMatchesPattern(host, p));
}

const JS_STRICTNESS: Record<JsPolicy, number> = { allowed: 0, review: 1, disabled: 2 };

export function strictestJs(...policies: Array<JsPolicy | undefined>): JsPolicy {
  let best: JsPolicy = 'allowed';
  for (const p of policies) if (p && JS_STRICTNESS[p] > JS_STRICTNESS[best]) best = p;
  return best;
}

function cleanList(list: readonly string[] | undefined): string[] {
  return (list ?? []).map(s => s.trim()).filter(s => s && normalizeHostPattern(s) !== null);
}

/** Combines the env base layer with an optional orchestrator override. Overrides can only tighten. */
export function mergePolicy(base: PolicyOverride, override?: PolicyOverride): EffectivePolicy {
  const allowLayers = [cleanList(base.domainAllow), cleanList(override?.domainAllow)].filter(l => l.length > 0);
  const deny = [...new Set([...cleanList(base.domainDeny), ...cleanList(override?.domainDeny)])];
  return { allowLayers, deny, js: strictestJs(base.js, override?.js) };
}

export const OPEN_POLICY: EffectivePolicy = { allowLayers: [], deny: [], js: 'allowed' };

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; code: 'scheme' | 'invalid' | 'denied' | 'not_allowlisted'; host?: string; reason: string };

export function domainNotAllowedMessage(host: string): string {
  return `domain not allowed by project policy: ${host} — ask the user to add it`;
}

export function domainDeniedMessage(host: string): string {
  return `domain blocked by project policy (denylist): ${host} — ask the user if it should be unblocked`;
}

function parseHost(url: string): { host: string } | PolicyDecision {
  if (isBlockedScheme(url)) {
    return { allowed: false, code: 'scheme', reason: `scheme not allowed in the browser: ${url.split(':')[0]}:` };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, code: 'invalid', reason: 'not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, code: 'scheme', reason: `scheme not allowed in the browser: ${parsed.protocol}` };
  }
  return { host: normalizeHost(parsed.hostname) };
}

/** Sub-resources (images, scripts, XHR, iframes…): only the denylist and the scheme block apply. */
export function checkRequest(policy: EffectivePolicy, url: string): PolicyDecision {
  // data:/blob: sub-resources never leave the browser; let them through.
  if (/^(data|blob):/i.test(url)) return { allowed: true };
  const h = parseHost(url);
  if ('allowed' in h) return h;
  if (hostMatchesAny(h.host, policy.deny)) {
    return { allowed: false, code: 'denied', host: h.host, reason: domainDeniedMessage(h.host) };
  }
  return { allowed: true };
}

/** Top-level navigations (including redirects of them): denylist, then every allowlist layer. */
export function checkNavigation(policy: EffectivePolicy, url: string): PolicyDecision {
  const h = parseHost(url);
  if ('allowed' in h) return h;
  if (hostMatchesAny(h.host, policy.deny)) {
    return { allowed: false, code: 'denied', host: h.host, reason: domainDeniedMessage(h.host) };
  }
  for (const layer of policy.allowLayers) {
    if (!hostMatchesAny(h.host, layer)) {
      return { allowed: false, code: 'not_allowlisted', host: h.host, reason: domainNotAllowedMessage(h.host) };
    }
  }
  return { allowed: true };
}

/** JS policy → Playwright context options. `review` runs JS (results are marked); `disabled` turns it off. */
export function jsContextOptions(js: JsPolicy): { javaScriptEnabled: boolean } {
  return { javaScriptEnabled: js !== 'disabled' };
}

export function parseJsPolicy(value: string | undefined, fallback: JsPolicy = 'allowed'): JsPolicy {
  const v = (value ?? '').trim().toLowerCase();
  return (JS_POLICIES as readonly string[]).includes(v) ? (v as JsPolicy) : fallback;
}

export function parsePatternList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}
