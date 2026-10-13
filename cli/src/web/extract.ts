import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { sanitizeLabel, sanitizeText } from './sanitize.js';
import { scoreInjection, type InjectionResult } from './injection.js';

/**
 * HTML → readable markdown for web_fetch, the same way every assistant does it: Readability picks the article
 * (drops navigation, ads, cookie banners), Turndown turns it into markdown. Deterministic, no model involved.
 * The result is sanitised (invisible Unicode stripped) and scored for prompt-injection patterns — a signal only,
 * the text is never rewritten or dropped.
 */

export interface ExtractedPage {
  title: string;
  markdown: string;
  injection: InjectionResult;
}

/** Cap on the markdown kept per page (what `offset` can page through). */
export const MAX_PAGE_CHARS = 400_000;

function absolutize(raw: string | null, base: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

interface LinkNode {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Resolves links against the page and drops javascript:/data: ones. */
function resolveLinks(document: { querySelectorAll(sel: string): Iterable<unknown> }, base: string): void {
  for (const node of Array.from(document.querySelectorAll('a[href]'))) {
    const a = node as LinkNode;
    const abs = absolutize(a.getAttribute('href'), base);
    if (abs) a.setAttribute('href', abs);
    else a.removeAttribute('href');
  }
}

function makeTurndown(): TurndownService {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  td.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'svg', 'canvas', 'form', 'button', 'select', 'input', 'textarea']);
  // Images are not useful as text and a URL in an image is a ready-made exfiltration channel if some client ever renders it.
  td.addRule('image-as-text', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = sanitizeLabel((node as unknown as { getAttribute(n: string): string | null }).getAttribute('alt') ?? '', 120).text;
      return alt ? `[image: ${alt}]` : '';
    },
  });
  return td;
}

export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const { document } = parseHTML(html);

  resolveLinks(document, pageUrl);

  const rawTitle = document.querySelector('title')?.textContent ?? '';
  const td = makeTurndown();

  let markdown = '';
  let title = rawTitle;
  try {
    // Readability mutates the document it is given; the fallback below needs the original, so it gets a copy.
    const copy = parseHTML(html).document;
    resolveLinks(copy, pageUrl);
    const article = new Readability(copy as never, { keepClasses: false }).parse();
    if (article?.content && (article.textContent ?? '').trim().length >= 200) {
      markdown = td.turndown(article.content);
      if (article.title) title = article.title;
    }
  } catch {
    // fall through to the whole-body fallback
  }

  if (!markdown.trim()) {
    // Not an article (a list, an app shell, a very short page): convert the whole body instead of returning nothing.
    const body = document.body ?? document.documentElement;
    markdown = body ? td.turndown(body.innerHTML ?? '') : '';
  }

  const cleanedTitle = sanitizeLabel(title, 200);
  const cleaned = sanitizeText(markdown, MAX_PAGE_CHARS);
  const stripped = {
    tagChars: cleaned.stats.tagChars + cleanedTitle.stats.tagChars,
    zeroWidth: cleaned.stats.zeroWidth + cleanedTitle.stats.zeroWidth,
    bidi: cleaned.stats.bidi + cleanedTitle.stats.bidi,
    control: cleaned.stats.control + cleanedTitle.stats.control,
  };
  const injection = scoreInjection({ text: cleaned.text, title: cleanedTitle.text, stripped });
  return { title: cleanedTitle.text, markdown: cleaned.text, injection };
}

/** Plain text types (txt, json, markdown, xml, csv…) are returned as they are, only sanitised. */
export function extractText(text: string): ExtractedPage {
  const cleaned = sanitizeText(text, MAX_PAGE_CHARS);
  const injection = scoreInjection({ text: cleaned.text, stripped: cleaned.stats });
  return { title: '', markdown: cleaned.text, injection };
}
