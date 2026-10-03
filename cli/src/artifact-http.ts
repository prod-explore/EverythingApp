/**
 * HTTP-safety helpers for user/agent-supplied artifact files (audit P2: artifacts were served inline
 * with a client-chosen MIME type from the app's own origin, i.e. an uploaded text/html or SVG was
 * active content next to the page that holds the API token).
 *
 * Rule: only content that cannot execute in the app's origin is shown inline; everything else is a
 * download. The MIME type STORED in the database is never trusted for serving.
 */

export interface ServePolicy {
  /** Show in the browser (true) or force a download (false). */
  inline: boolean;
  /** The Content-Type actually sent. */
  contentType: string;
  /** Add `Content-Security-Policy: sandbox` (script-less, opaque-origin) — for anything a browser renders itself. */
  sandbox: boolean;
}

const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const INLINE_AS_TEXT = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

export function servePolicy(storedMime: string): ServePolicy {
  const mime = storedMime.split(';')[0]!.trim().toLowerCase();
  if (INLINE_IMAGES.has(mime)) return { inline: true, contentType: mime, sandbox: true };
  // PDF viewers are plugins: a CSP sandbox would disable them, and PDFs do not run in the page's origin.
  if (mime === 'application/pdf') return { inline: true, contentType: 'application/pdf', sandbox: false };
  // Text is always delivered as text/plain so a browser can never render it as HTML/XML.
  if (INLINE_AS_TEXT.has(mime)) return { inline: true, contentType: 'text/plain; charset=utf-8', sandbox: true };
  // html, svg, xml, javascript, archives, unknown…: download only.
  return { inline: false, contentType: 'application/octet-stream', sandbox: true };
}

/** RFC 6266 Content-Disposition with an ASCII fallback and an RFC 5987 UTF-8 `filename*` — no header injection. */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^A-Za-z0-9._-]/g, '_') || 'file';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Last path segment only, control characters removed, bounded length, never empty. */
export function sanitizeFilename(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let name = raw.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop()!.trim();
  if (name === '.' || name === '..') name = '';
  if (name.length > 120) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name || 'artifact';
}
