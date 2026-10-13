import * as http from 'node:http';
import * as https from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { assertPublicUrl, isPrivateAddress, UrlBlockedError } from './url-safety.js';

/**
 * A small HTTP(S) GET for web_fetch. What makes it different from fetch():
 *  - every address the host resolves to is checked AT CONNECTION TIME (custom `lookup`), so DNS rebinding cannot
 *    slip a private address in after a first, public answer;
 *  - redirects are followed by hand, and only within the same host — a redirect to another host is handed back to the
 *    caller, because another host is another domain the user has to approve;
 *  - the body is read through the decompressor with a hard byte cap (a gzip bomb stops at the cap), and the whole
 *    request has a deadline.
 */

export const FETCH_USER_AGENT = 'Mozilla/5.0 (compatible; EverythingAppBot/1.0; +https://futumore.pl)';

export interface FetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  /** Test seam: replaces DNS. Must return every address of the host. */
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  /** Test seam: replaces the per-address private check (tests listen on 127.0.0.1). */
  isBlockedAddress?: (ip: string) => boolean;
}

export interface FetchResult {
  /** The URL the body came from (after same-host redirects). */
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  /** The body was cut at maxBytes. */
  truncated: boolean;
  /** Set instead of a body when the server redirected to another host: the caller must ask for approval first. */
  redirectTo?: string;
}

export class FetchError extends Error {}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

function makeLookup(opts: FetchOptions) {
  const blocked = opts.isBlockedAddress ?? isPrivateAddress;
  const resolve = opts.resolve ?? ((host: string) => new Promise<LookupAddress[]>((res, rej) =>
    dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? rej(err) : res(addrs)))));
  return (hostname: string, options: { all?: boolean }, cb: (err: Error | null, address?: string | LookupAddress[], family?: number) => void): void => {
    resolve(hostname).then(addrs => {
      if (addrs.length === 0) return cb(new FetchError(`could not resolve "${hostname}"`));
      // ANY private record blocks: a host with both a public and a private address is a rebinding setup.
      if (addrs.some(a => blocked(a.address))) {
        return cb(new UrlBlockedError(hostname, `"${hostname}" resolves to a private/internal address — web_fetch may only reach the public internet`));
      }
      if (options.all) return cb(null, addrs);
      cb(null, addrs[0]!.address, addrs[0]!.family);
    }, err => cb(err instanceof Error ? err : new FetchError(String(err))));
  };
}

function decoderFor(encoding: string | undefined): ReturnType<typeof createGunzip> | null {
  switch ((encoding ?? '').toLowerCase().trim()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      return null;
  }
}

function readCapped(stream: Readable, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (truncated: boolean) => {
      if (done) return;
      done = true;
      stream.destroy();
      resolve({ body: Buffer.concat(chunks), truncated });
    };
    stream.on('data', (chunk: Buffer) => {
      const room = maxBytes - size;
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room));
        size += room;
        finish(true);
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    stream.on('end', () => finish(false));
    stream.on('error', err => { if (!done) { done = true; reject(err); } });
  });
}

function requestOnce(url: URL, opts: FetchOptions, deadline: AbortSignal): Promise<{ res: http.IncomingMessage; req: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET',
      // A fresh connection per request: no pooled socket, so the address check in `lookup` runs for every request.
      agent: false,
      lookup: makeLookup(opts) as never,
      headers: {
        'User-Agent': FETCH_USER_AGENT,
        Accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8, application/json;q=0.7, */*;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en,pl;q=0.8',
      },
      signal: deadline,
    }, res => resolve({ res, req }));
    req.on('error', err => reject(err));
    req.end();
  });
}

/** Rewrites the low-level errors into sentences a model (and a person) can act on. */
function describeError(err: unknown, url: string): Error {
  if (err instanceof UrlBlockedError || err instanceof FetchError) return err;
  const e = err as NodeJS.ErrnoException;
  if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return new FetchError(`Timed out fetching ${url}`);
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return new FetchError(`Could not resolve the host of ${url}`);
  if (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') return new FetchError(`Could not connect to ${url} (${e.code})`);
  if (typeof e.code === 'string' && e.code.startsWith('ERR_TLS') || /certificate|SSL|TLS/i.test(e.message)) return new FetchError(`TLS error for ${url}: ${e.message}`);
  return err instanceof Error ? err : new FetchError(String(err));
}

export async function fetchPublic(rawUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? 5;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const deadline = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;

  let current = assertPublicUrl(rawUrl);
  const originHost = current.hostname.toLowerCase();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res: http.IncomingMessage;
    try {
      ({ res } = await requestOnce(current, opts, deadline));
    } catch (err) {
      throw describeError(err, current.href);
    }
    const status = res.statusCode ?? 0;

    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      let next: URL;
      try {
        next = new URL(res.headers.location, current);
      } catch {
        throw new FetchError(`Invalid redirect from ${current.href}`);
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new FetchError(`Redirect to a non-web URL refused: ${next.protocol}`);
      if (next.hostname.toLowerCase() !== originHost) {
        return { url: current.href, status, contentType: '', body: Buffer.alloc(0), truncated: false, redirectTo: next.href };
      }
      current = assertPublicUrl(next.href);
      continue;
    }

    const decoder = decoderFor(res.headers['content-encoding'] as string | undefined);
    const source: Readable = decoder ? res.pipe(decoder) : res;
    if (decoder) res.on('error', err => decoder.destroy(err));
    try {
      const { body, truncated } = await readCapped(source, maxBytes);
      res.destroy();
      return { url: current.href, status, contentType: String(res.headers['content-type'] ?? ''), body, truncated };
    } catch (err) {
      res.destroy();
      throw describeError(err, current.href);
    }
  }
  throw new FetchError(`Too many redirects (more than ${maxRedirects}) fetching ${rawUrl}`);
}
