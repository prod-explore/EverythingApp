import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { BrowserContext } from 'playwright';

/**
 * SSRF protection for the browser agent.
 *
 * The agent (and any page it opens) must be able to reach the PUBLIC internet freely — shops,
 * price checks, docs — but never the operator's own network: loopback, the LAN (router, NAS,
 * Skarpa, n8n), link-local / cloud-metadata addresses, other containers, the Docker host.
 * That is the same rule every hosted IDE/agent sandbox applies.
 *
 * Defence in depth — this guard is the application layer; the network layer (DOCKER-USER
 * rules, see deploy/egress-guard.sh) is the backstop. Two places enforce it here:
 *   1. tools check the URL the model asked for (clear error message),
 *   2. installRequestGuard() checks EVERY request the browser makes (redirects, sub-resources,
 *      a public page embedding http://192.168.1.1/…), which is where SSRF actually happens.
 */

/** Scheme allowlist. Only http(s) — no file:, data:, javascript:, etc. */
export function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseIPv4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const bytes = m.slice(1).map(Number);
  return bytes.every(b => b >= 0 && b <= 255) ? bytes : null;
}

function parseIPv6(input: string): number[] | null {
  let ip = input.split('%')[0]!; // strip zone id
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (tail) {
    const b = parseIPv4(tail[1]!);
    if (!b) return null;
    ip = `${ip.slice(0, -tail[1]!.length)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const split = (s: string) => (s === '' ? [] : s.split(':'));
  const head = split(halves[0]!);
  const rest = halves.length === 2 ? split(halves[1]!) : [];
  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...rest];
  }
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    out.push(n >> 8, n & 255);
  }
  return out;
}

function isPrivateIPv4(b: number[]): boolean {
  const [a, c, d] = [b[0]!, b[1]!, b[2]!];
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && c >= 64 && c <= 127) || // CGNAT — also Tailscale
    (a === 169 && c === 254) || // link-local, cloud metadata
    (a === 172 && c >= 16 && c <= 31) || // Docker default bridges live here
    (a === 192 && c === 0 && d === 0) ||
    (a === 192 && c === 0 && d === 2) ||
    (a === 192 && c === 168) ||
    (a === 198 && (c === 18 || c === 19)) ||
    (a === 198 && c === 51 && d === 100) ||
    (a === 203 && c === 0 && d === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

function isPrivateIPv6(b: number[]): boolean {
  const zero = (from: number, to: number) => b.slice(from, to).every(x => x === 0);
  // ::, ::1 and IPv4-compatible ::a.b.c.d — judge by the embedded IPv4 (0.x.x.x is private anyway).
  if (zero(0, 12)) return isPrivateIPv4(b.slice(12));
  // ::ffff:a.b.c.d (IPv4-mapped)
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateIPv4(b.slice(12));
  // 64:ff9b::/96 (NAT64)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return isPrivateIPv4(b.slice(12));
  // 2002::/16 (6to4) embeds the IPv4 in bytes 2..5
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIPv4(b.slice(2, 6));
  // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true;
  // 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1]! & 0x80) === 0x80) return true; // fe80::/10 link-local, fec0::/10 site-local
  if (b[0] === 0xff) return true; // multicast
  return false;
}

/** True for any loopback/private/link-local/reserved address. Unparseable input counts as private (fail closed). */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const v = isIP(bare.split('%')[0]!);
  if (v === 4) {
    const b = parseIPv4(bare);
    return b ? isPrivateIPv4(b) : true;
  }
  if (v === 6) {
    const b = parseIPv6(bare);
    return b ? isPrivateIPv6(b) : true;
  }
  return true;
}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.localdomain', '.intranet', '.corp'];

export class UrlBlockedError extends Error {
  constructor(public readonly url: string, public readonly reason: string) {
    super(`Blocked: ${reason}`);
    this.name = 'UrlBlockedError';
  }
}

export interface UrlGuardOptions {
  /** Hostnames / IP literals reachable even though private — an explicit operator opt-in (BROWSER_ALLOW_PRIVATE_HOSTS). */
  allowHosts?: readonly string[];
  /** DNS seam for tests. Must return every A/AAAA record. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** How long a hostname's resolution is cached (per-request checks would otherwise hammer DNS). */
  cacheTtlMs?: number;
  now?: () => number;
}

const defaultResolve = async (hostname: string): Promise<string[]> =>
  (await lookup(hostname, { all: true, verbatim: true })).map(r => r.address);

export class UrlGuard {
  private readonly allow: Set<string>;
  private readonly resolve: (hostname: string) => Promise<string[]>;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { addrs: string[]; expires: number }>();

  constructor(opts: UrlGuardOptions = {}) {
    this.allow = new Set((opts.allowHosts ?? []).map(h => h.trim().toLowerCase()).filter(Boolean));
    this.resolve = opts.resolve ?? defaultResolve;
    this.ttl = opts.cacheTtlMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  /** Throws UrlBlockedError unless the URL is http(s) and every address its host resolves to is public. */
  async check(rawUrl: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new UrlBlockedError(rawUrl, 'not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new UrlBlockedError(rawUrl, 'only http/https URLs are allowed');
    }
    // WHATWG parsing already normalises 2130706433 / 0x7f.1 / 017700000001 to dotted-decimal.
    let host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (this.allow.has(host)) return;

    const privateMsg = `"${host}" is on a private/internal network — the browser may only reach the public internet`;
    if (host === 'localhost' || INTERNAL_SUFFIXES.some(s => host.endsWith(s))) throw new UrlBlockedError(rawUrl, privateMsg);

    if (isIP(host)) {
      if (isPrivateAddress(host)) throw new UrlBlockedError(rawUrl, privateMsg);
      return;
    }

    let addrs: string[];
    const hit = this.cache.get(host);
    if (hit && hit.expires > this.now()) {
      addrs = hit.addrs;
    } else {
      try {
        addrs = await this.resolve(host);
      } catch {
        throw new UrlBlockedError(rawUrl, `could not resolve "${host}"`);
      }
      this.cache.set(host, { addrs, expires: this.now() + this.ttl });
    }
    if (addrs.length === 0) throw new UrlBlockedError(rawUrl, `could not resolve "${host}"`);
    // ANY private record blocks: a host that resolves to both a public and a private address is a rebinding setup.
    if (addrs.some(isPrivateAddress)) throw new UrlBlockedError(rawUrl, privateMsg);
  }

  async isAllowed(rawUrl: string): Promise<boolean> {
    try {
      await this.check(rawUrl);
      return true;
    } catch {
      return false;
    }
  }
}

/** Parses the BROWSER_ALLOW_PRIVATE_HOSTS env value ("host1, 10.0.0.5"). */
export function parseAllowHosts(value: string | undefined): string[] {
  return (value ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Enforces the guard on EVERY request a context makes — top-level navigations, redirects and
 * sub-resources alike. Blocked requests are aborted (surfacing as net::ERR_BLOCKED_BY_CLIENT).
 */
export async function installRequestGuard(
  context: BrowserContext,
  guard: UrlGuard,
  onBlock?: (url: string) => void,
): Promise<void> {
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (await guard.isAllowed(url)) {
      await route.continue();
    } else {
      onBlock?.(url);
      await route.abort('blockedbyclient');
    }
  });
}
