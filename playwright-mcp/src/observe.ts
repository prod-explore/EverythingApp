import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import type { PlaywrightConfig } from './config.js';
import { scoreInjection, type InjectionResult } from './injection.js';
import type { JsPolicy } from './policy.js';
import { summarizeObservation } from './quarantine.js';
import { addStats, emptyStats, sanitizeLabel, sanitizeText, type SanitizeStats } from './sanitize.js';

/**
 * Observation v2 — the deterministic source of truth for what the agent sees of a page.
 *
 * No LLM sits between the page and the agent any more. Code collects visible text and interactive
 * elements (in-page script below), Node cleans them (sanitize.ts), builds the element table with
 * exact refs (the same refs browser_act resolves), bounds the page text and wraps it — and every
 * label — in a nonce-tagged untrusted-data block (spotlighting). A heuristic classifier
 * (injection.ts) flags likely prompt injection as a signal; it never rewrites content.
 *
 * Labels and text DO come from the page: they are untrusted data and are presented as such.
 */

/** One interactive element as collected in the page (raw — not yet sanitised). */
export interface RawElement {
  ref: number;
  tag: string;
  role: string | null;
  label: string;
  href?: string;
  /** For <input>: its type attribute. */
  type?: string;
  disabled?: boolean;
}

/** What the in-page collector returns. */
export interface PageCapture {
  url: string;
  title: string;
  /** Visible text, one block per line. */
  text: string;
  /** Sample of text the page renders invisibly (for the injection signal only — never shown). */
  hiddenText: string;
  visibleChars: number;
  hiddenChars: number;
  elements: RawElement[];
  /** True when the collector hit one of its in-page caps. */
  textCapped: boolean;
  elementsCapped: boolean;
}

export interface CollectArgs {
  selector: string;
  maxTextChars: number;
  maxHiddenChars: number;
  maxElements: number;
  maxLabelChars: number;
  maxTextNodes: number;
}

export const INTERACTIVE_SELECTOR =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
  '[role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], ' +
  '[role="menuitem"], [role="option"], [role="combobox"], [role="textbox"], [contenteditable="true"]';

/**
 * Runs INSIDE the page via page.evaluate() — must stay self-contained (Playwright serialises it).
 *
 * Visibility = rendered for a sighted human: not display:none / visibility:hidden / opacity 0 /
 * clipped / zero-size / off-screen / aria-hidden / inert / font-size 0 / transparent colour, and —
 * for in-viewport interactive elements — actually hit by elementFromPoint (not covered by
 * something else). script/style/template/noscript are skipped; comments are never visited
 * (text-node walk only).
 *
 * Also tags each listed element with data-ea-ref so browser_act can resolve the ref later, after
 * first clearing refs from the previous observation so a stale number can never match.
 */
export function collectPageCapture(args: CollectArgs): PageCapture {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'TITLE', 'META', 'LINK', 'IFRAME', 'OBJECT', 'EMBED']);
  const doc = document.documentElement;
  const docW = Math.max(doc.scrollWidth, window.innerWidth);
  const docH = Math.max(doc.scrollHeight, window.innerHeight);
  const sx = window.scrollX;
  const sy = window.scrollY;

  const styleCache = new Map<Element, CSSStyleDeclaration>();
  const style = (el: Element): CSSStyleDeclaration => {
    let s = styleCache.get(el);
    if (!s) {
      s = window.getComputedStyle(el);
      styleCache.set(el, s);
    }
    return s;
  };

  const isClipped = (el: Element, cs: CSSStyleDeclaration): boolean => {
    const clip = cs.clip;
    if (clip && clip !== 'auto' && /rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(clip)) return true;
    const cp = cs.clipPath;
    if (cp && cp !== 'none' && (/inset\(\s*(50|100)%/.test(cp) || /circle\(\s*0(px|%)?\s*[ )]/.test(cp))) return true;
    if (cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return true; // "sr-only" boxes
    }
    return false;
  };

  // Properties that hide an element AND all its descendants (visibility is handled separately,
  // since a descendant can set visibility:visible again).
  const subtreeCache = new Map<Element, boolean>();
  const subtreeVisible = (el: Element | null): boolean => {
    if (!el) return true;
    const cached = subtreeCache.get(el);
    if (cached !== undefined) return cached;
    let ok = true;
    if (SKIP.has(el.tagName.toUpperCase())) ok = false;
    else if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden') || (el as HTMLElement).inert) ok = false;
    else {
      const cs = style(el);
      if (cs.display === 'none' || parseFloat(cs.opacity) === 0 || cs.contentVisibility === 'hidden' || isClipped(el, cs)) {
        ok = false;
      }
    }
    if (ok) ok = subtreeVisible(el.parentElement);
    subtreeCache.set(el, ok);
    return ok;
  };

  const transparent = (color: string): boolean =>
    color === 'transparent' || /^rgba\(.*,\s*0(\.0+)?\)$/.test(color.replace(/\s+/g, ' '));

  const offscreen = (r: DOMRect): boolean => {
    const left = r.left + sx;
    const top = r.top + sy;
    return left + r.width <= 0 || top + r.height <= 0 || left >= docW || top >= docH;
  };

  const textNodeVisible = (t: Text): boolean => {
    const p = t.parentElement;
    if (!p || !subtreeVisible(p)) return false;
    const cs = style(p);
    if (cs.visibility !== 'visible') return false;
    if (parseFloat(cs.fontSize) < 1) return false;
    if (transparent(cs.color)) return false;
    const range = document.createRange();
    range.selectNodeContents(t);
    const r = range.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    return !offscreen(r);
  };

  const blockCache = new Map<Element, Element>();
  const blockOf = (el: Element): Element => {
    const cached = blockCache.get(el);
    if (cached) return cached;
    let cur: Element = el;
    while (cur.parentElement && style(cur).display.startsWith('inline')) cur = cur.parentElement;
    blockCache.set(el, cur);
    return cur;
  };

  // ── Text ────────────────────────────────────────────────────────────────
  let text = '';
  let hiddenText = '';
  let visibleChars = 0;
  let hiddenChars = 0;
  let textCapped = false;
  let lastBlock: Element | null = null;
  let visited = 0;
  const root = document.body ?? doc;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => {
      // Reject text inside skipped tags outright — script/style contents are not "hidden text".
      let a = n.parentElement;
      while (a) {
        if (SKIP.has(a.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
        a = a.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (++visited > args.maxTextNodes) {
      textCapped = true;
      break;
    }
    const t = n as Text;
    const raw = t.data;
    const len = raw.replace(/\s+/g, '').length;
    if (len === 0) continue;
    if (textNodeVisible(t)) {
      visibleChars += len;
      if (text.length < args.maxTextChars) {
        const block = blockOf(t.parentElement!);
        if (lastBlock && block !== lastBlock) text += '\n';
        lastBlock = block;
        text += raw;
      } else textCapped = true;
    } else {
      hiddenChars += len;
      if (hiddenText.length < args.maxHiddenChars) hiddenText += raw + '\n';
    }
  }

  const visibleTextOf = (el: Element, max: number): string => {
    let out = '';
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n && out.length < max; n = w.nextNode()) {
      if (textNodeVisible(n as Text)) out += (n as Text).data;
    }
    return out.replace(/\s+/g, ' ').trim();
  };

  // ── Elements ────────────────────────────────────────────────────────────
  document.querySelectorAll('[data-ea-ref]').forEach(e => e.removeAttribute('data-ea-ref'));

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const hitTest = (el: Element, r: DOMRect): boolean => {
    const inViewport = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    if (!inViewport) return true; // below the fold: Playwright scrolls it into view on click
    const clampX = (x: number) => Math.min(Math.max(x, 0), vw - 1);
    const clampY = (y: number) => Math.min(Math.max(y, 0), vh - 1);
    const pts: Array<[number, number]> = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 2, r.top + 2],
      [r.right - 2, r.top + 2],
      [r.left + 2, r.bottom - 2],
      [r.right - 2, r.bottom - 2],
    ];
    for (const [x, y] of pts) {
      const hit = document.elementFromPoint(clampX(x), clampY(y));
      if (!hit) continue;
      if (hit === el || el.contains(hit)) return true;
      const lbl = hit.closest('label') as HTMLLabelElement | null;
      if (lbl && lbl.control === el) return true;
    }
    return false;
  };

  const elementVisible = (el: HTMLElement): boolean => {
    if (!subtreeVisible(el)) return false;
    if (style(el).visibility !== 'visible') return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    if (offscreen(r)) return false;
    return hitTest(el, r);
  };

  const labelOf = (el: HTMLElement): string => {
    const max = args.maxLabelChars * 2;
    const tag = el.tagName;
    const input = el as HTMLInputElement;
    const isField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    const candidates: Array<() => string | null | undefined> = [];
    if (!isField) candidates.push(() => visibleTextOf(el, max));
    candidates.push(() => el.getAttribute('aria-label'));
    candidates.push(() => {
      const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
      return ids.map(id => document.getElementById(id)?.textContent ?? '').join(' ');
    });
    if (isField) {
      candidates.push(() => (input.labels && input.labels[0] ? visibleTextOf(input.labels[0], max) : null));
      candidates.push(() => input.placeholder);
    }
    candidates.push(() => el.getAttribute('alt'));
    candidates.push(() => el.querySelector('img[alt]')?.getAttribute('alt'));
    candidates.push(() => el.getAttribute('title'));
    if (tag === 'INPUT' && /^(submit|button|reset)$/i.test(input.type)) candidates.push(() => input.value);
    if (isField) candidates.push(() => el.getAttribute('name'));
    for (const c of candidates) {
      const v = (c() ?? '').replace(/\s+/g, ' ').trim();
      if (v) return v.slice(0, max);
    }
    return '';
  };

  const elements: RawElement[] = [];
  let elementsCapped = false;
  let ref = 1;
  for (const node of Array.from(document.querySelectorAll(args.selector))) {
    const el = node as HTMLElement;
    if (!elementVisible(el)) continue;
    if (elements.length >= args.maxElements) {
      elementsCapped = true;
      break;
    }
    const thisRef = ref++;
    el.setAttribute('data-ea-ref', String(thisRef));
    const tag = el.tagName.toLowerCase();
    elements.push({
      ref: thisRef,
      tag,
      role: el.getAttribute('role'),
      label: labelOf(el),
      href: tag === 'a' ? (el as HTMLAnchorElement).href : undefined,
      type: tag === 'input' ? ((el as HTMLInputElement).type || 'text').toLowerCase() : undefined,
      disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined,
    });
  }

  return {
    url: window.location.href,
    title: document.title,
    text,
    hiddenText,
    visibleChars,
    hiddenChars,
    elements,
    textCapped,
    elementsCapped,
  };
}

export function collectArgsFor(config: PlaywrightConfig): CollectArgs {
  return {
    selector: INTERACTIVE_SELECTOR,
    // Collect generously in-page (the injection scorer sees more than the agent does), cap in Node.
    maxTextChars: Math.max(config.observationMaxTextChars * 4, 50_000),
    maxHiddenChars: 20_000,
    maxElements: config.observationMaxElements,
    maxLabelChars: config.observationLabelMaxChars,
    maxTextNodes: 50_000,
  };
}

export async function capturePage(page: Page, config: PlaywrightConfig): Promise<PageCapture> {
  return page.evaluate(collectPageCapture, collectArgsFor(config));
}

// ── Node-side post-processing (pure, unit-tested) ─────────────────────────

const SAFE_HREF_MAX = 200;

/** Keeps http(s) hrefs (sanitised, capped); anything else is shown as its scheme only. */
export function cleanHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const h = sanitizeLabel(href, SAFE_HREF_MAX).text;
  if (/^https?:\/\//i.test(h)) return h;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(h)?.[1];
  return scheme ? `(${scheme.toLowerCase()}: link)` : undefined;
}

export interface CleanElements {
  elements: RawElement[];
  stats: SanitizeStats;
}

export function cleanElements(raw: RawElement[], labelMax: number): CleanElements {
  let stats = emptyStats();
  const elements = raw.map(e => {
    const l = sanitizeLabel(e.label, labelMax);
    stats = addStats(stats, l.stats);
    return {
      ...e,
      tag: e.tag.toLowerCase().replace(/[^a-z0-9-]/g, ''),
      role: e.role ? sanitizeLabel(e.role, 30).text.replace(/[^\w-]/g, '') || null : null,
      type: e.type ? e.type.toLowerCase().replace(/[^a-z-]/g, '').slice(0, 20) : undefined,
      label: l.text || '(unlabeled)',
      href: cleanHref(e.href),
    };
  });
  return { elements, stats };
}

/** One line per element, exact refs — the table browser_act's refs refer to. Built without any LLM. */
export function formatElementTable(elements: RawElement[]): string {
  if (elements.length === 0) return '(no interactive elements found on this page)';
  return elements
    .map(e => {
      const kind = e.role ?? (e.tag === 'input' && e.type ? `input(${e.type})` : e.tag);
      // JSON.stringify escapes quotes/backslashes so a label can't break out of its quotes.
      return `[${e.ref}] ${kind}: ${JSON.stringify(e.label)}${e.disabled ? ' (disabled)' : ''}${e.href ? ` → ${e.href}` : ''}`;
    })
    .join('\n');
}

export function newNonce(): string {
  return randomBytes(9).toString('hex');
}

/** Neutralises anything in page content that looks like our own delimiter, so it can't close the block early. */
export function escapeDelimiters(content: string): string {
  return content.replace(/<(\/?\s*untrusted_)/gi, '‹$1');
}

/**
 * Spotlighting: wraps untrusted content between nonce-tagged markers. The nonce is random per
 * observation, so page content can't forge a closing marker.
 */
export function wrapUntrusted(content: string, nonce: string, tag = 'untrusted_page_content'): string {
  return `<${tag} nonce="${nonce}">\n${escapeDelimiters(content)}\n</${tag} nonce="${nonce}">`;
}

export interface Observation {
  url: string;
  title: string;
  nonce: string;
  elements: RawElement[];
  elementTable: string;
  elementCount: number;
  elementsTruncated: boolean;
  pageText: string;
  pageTextChars: number;
  pageTextTruncated: boolean;
  hiddenTextRatio: number;
  injection: InjectionResult;
  jsPolicy: JsPolicy;
  /** Optional quarantine-model summary (OBSERVATION_QUARANTINE_ENABLED) — derived from untrusted content. */
  summary?: string;
  summaryModel?: string;
  /** Set when the optional summary was requested but failed validation/the call failed. */
  summaryError?: string;
}

export interface BuildOptions {
  maxTextChars: number;
  labelMax: number;
  jsPolicy: JsPolicy;
  nonce?: string;
}

/** Pure: capture → observation. Everything the agent will see is decided here, deterministically. */
export function buildObservation(capture: PageCapture, opts: BuildOptions): Observation {
  const text = sanitizeText(capture.text, opts.maxTextChars);
  const hidden = sanitizeText(capture.hiddenText);
  const title = sanitizeLabel(capture.title, 200);
  const url = sanitizeLabel(capture.url, 500);
  const { elements, stats: labelStats } = cleanElements(capture.elements, opts.labelMax);

  const stripped = addStats(addStats(addStats(text.stats, hidden.stats), labelStats), title.stats);
  // Score the full cleaned visible text (not just the capped part) — the scorer is a signal over the page.
  const fullText = text.truncated ? sanitizeText(capture.text).text : text.text;
  const injection = scoreInjection({
    text: fullText,
    labels: elements.map(e => e.label),
    title: title.text,
    hiddenText: hidden.text,
    visibleChars: capture.visibleChars,
    hiddenChars: capture.hiddenChars,
    stripped,
  });

  const total = capture.visibleChars + capture.hiddenChars;
  return {
    url: url.text,
    title: title.text,
    nonce: opts.nonce ?? newNonce(),
    elements,
    elementTable: formatElementTable(elements),
    elementCount: elements.length,
    elementsTruncated: capture.elementsCapped,
    pageText: text.text,
    pageTextChars: text.text.length,
    pageTextTruncated: text.truncated || capture.textCapped,
    hiddenTextRatio: total > 0 ? Math.round((capture.hiddenChars / total) * 100) / 100 : 0,
    injection,
    jsPolicy: opts.jsPolicy,
  };
}

/**
 * The one function every step of the browser-agent loop calls before returning anything to the
 * model. The optional quarantine summary is additive only — it never replaces the deterministic
 * element table or text.
 */
export async function observePage(page: Page, config: PlaywrightConfig, jsPolicy: JsPolicy): Promise<Observation> {
  const capture = await capturePage(page, config);
  const obs = buildObservation(capture, {
    maxTextChars: config.observationMaxTextChars,
    labelMax: config.observationLabelMaxChars,
    jsPolicy,
  });
  if (config.observationQuarantineEnabled) {
    const s = await summarizeObservation(config, obs.pageText);
    if (s.ok) {
      obs.summary = s.summary;
      obs.summaryModel = s.model;
    } else {
      obs.summaryError = s.error;
    }
  }
  return obs;
}
