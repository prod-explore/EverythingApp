import { randomBytes } from 'node:crypto';

/**
 * Spotlighting for text that came from the internet: it is wrapped between nonce-tagged markers, and anything in it
 * that looks like our own delimiter is neutralised, so a page cannot close the block early and speak as the system.
 * The same convention the browser tools use.
 */

export function newNonce(): string {
  return randomBytes(9).toString('hex');
}

export function escapeDelimiters(content: string): string {
  return content.replace(/<(\/?\s*untrusted_)/gi, '‹$1');
}

export function wrapUntrusted(content: string, nonce: string, tag = 'untrusted_web_content'): string {
  return `<${tag} nonce="${nonce}">\n${escapeDelimiters(content)}\n</${tag} nonce="${nonce}">`;
}

/** First line of a web tool result: the orchestrator reads it to warn about a suspected prompt injection. */
export const META_PREFIX = '[browser-meta] ';

export function metaLine(meta: { suspected: boolean; score: number; reasons: string[] }, extra: Record<string, unknown> = {}): string {
  return META_PREFIX + JSON.stringify({ ...extra, injection_suspected: meta.suspected, injection_score: meta.score, injection_reasons: meta.reasons });
}
