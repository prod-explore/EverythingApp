import type { Page } from 'playwright';
import type { PlaywrightConfig } from './config.js';
import { quarantineObservation } from './quarantine.js';

/**
 * One interactive element on the page, as seen by code (not an LLM) — this
 * extraction step is deliberately dumb pattern-matching over the DOM, never
 * an LLM call, so it can't itself be steered by page content. Its output is
 * still treated as untrusted below (label text comes from the page).
 */
export interface RawElement {
  ref: number;
  tag: string;
  role: string | null;
  label: string;
  href?: string;
}

export interface RawObservation {
  url: string;
  title: string;
  visibleText: string;
  elements: RawElement[];
}

const INTERACTIVE_SELECTOR =
  'a[href], button, input, select, textarea, ' +
  '[role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"]';

/**
 * Runs INSIDE the page via page.evaluate() — must stay self-contained (no
 * closures over anything outside this function; Playwright serializes it and
 * executes it in the browser, not in Node). Also tags each element with
 * data-ea-ref so browser_act can resolve a ref back to a real element later
 * without re-walking the DOM in the same order (order can shift between
 * calls if the page re-renders).
 */
function collectRawObservation(selector: string): RawObservation {
  const nodes = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
  const elements: Array<{ ref: number; tag: string; role: string | null; label: string; href?: string }> = [];
  let ref = 1;
  for (const el of nodes) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    const inputLike = el as HTMLInputElement;
    const label =
      el.getAttribute('aria-label') ||
      inputLike.placeholder ||
      el.getAttribute('alt') ||
      (el.innerText ?? '').trim().slice(0, 120) ||
      inputLike.value ||
      '(unlabeled)';

    const thisRef = ref++;
    el.setAttribute('data-ea-ref', String(thisRef));
    elements.push({
      ref: thisRef,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      label,
      href: el.tagName === 'A' ? (el as HTMLAnchorElement).href : undefined,
    });
  }
  return {
    url: window.location.href,
    title: document.title,
    visibleText: document.body.innerText,
    elements,
  };
}

export async function captureRawObservation(page: Page): Promise<RawObservation> {
  return page.evaluate(collectRawObservation, INTERACTIVE_SELECTOR);
}

export function formatElementTable(elements: RawElement[]): string {
  if (elements.length === 0) return '(no interactive elements found on this page)';
  return elements
    .map(e => `[${e.ref}] ${e.role ?? e.tag}: "${e.label}"${e.href ? ` → ${e.href}` : ''}`)
    .join('\n');
}

export interface QuarantinedObservation {
  url: string;
  title: string;
  elementTable: string;
  summary: string;
  elementCount: number;
  quarantineModel: string;
}

/**
 * The one function every step of the browser-agent loop calls before
 * returning anything to the model. Raw DOM text never leaves this file.
 */
export async function observePage(page: Page, config: PlaywrightConfig): Promise<QuarantinedObservation> {
  const raw = await captureRawObservation(page);
  const rawTable = formatElementTable(raw.elements);
  const sanitized = await quarantineObservation(config, raw.visibleText, rawTable);
  return {
    url: raw.url,
    title: raw.title,
    elementTable: sanitized.elementTable,
    summary: sanitized.summary,
    elementCount: raw.elements.length,
    quarantineModel: sanitized.model,
  };
}
