import { isIP } from 'node:net';

/**
 * SSRF protection for web_fetch: the model may read the PUBLIC internet, never the operator's own network
 * (loopback, LAN, Tailscale/CGNAT, link-local and cloud-metadata addresses, other containers).
 * Same rules as the browser's guard in playwright-mcp (urlSafety.ts), which is a separate package.
 *
 * Name resolution is checked at connection time (see http.ts), not only before it — a host that answers with a
 * public address first and a private one at connect time (DNS rebinding) is refused.
 */

export class UrlBlockedError extends Error {
  constructor(public readonly url: string, public readonly reason: string) {
    super(`Blocked: ${reason}`);
    this.name = 'UrlBlockedError';
  }
}

function parseIPv4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const bytes = m.slice(1).map(Number);
  return bytes.every(b => b >= 0 && b <= 255) ? bytes : null;
}

function parseIPv6(input: string): number[] | null {
  let ip = input.split('%')[0]!;
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
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && c >= 64 && c <= 127) || // CGNAT — also Tailscale
    (a === 169 && c === 254) || // link-local, cloud metadata
    (a === 172 && c >= 16 && c <= 31) || // Docker default bridges
    (a === 192 && c === 0 && d === 0) ||
    (a === 192 && c === 0 && d === 2) ||
    (a === 192 && c === 168) ||
    (a === 198 && (c === 18 || c === 19)) ||
    (a === 198 && c === 51 && d === 100) ||
    (a === 203 && c === 0 && d === 113) ||
    a >= 224
  );
}

function isPrivateIPv6(b: number[]): boolean {
  const zero = (from: number, to: number) => b.slice(from, to).every(x => x === 0);
  if (zero(0, 12)) return isPrivateIPv4(b.slice(12));
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateIPv4(b.slice(12));
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return isPrivateIPv4(b.slice(12));
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIPv4(b.slice(2, 6));
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true;
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;
  if ((b[0]! & 0xfe) === 0xfc) return true;
  if (b[0] === 0xfe && (b[1]! & 0x80) === 0x80) return true;
  if (b[0] === 0xff) return true;
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

/** Lower-cased hostname without brackets or a trailing dot, or null when `raw` is not an http(s) URL. */
export function hostOfUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  let host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host || null;
}

/** Cheap checks that need no DNS: scheme, credentials, internal names and IP literals. Throws UrlBlockedError. */
export function assertPublicUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UrlBlockedError(raw, 'not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new UrlBlockedError(raw, 'only http/https URLs are allowed');
  if (parsed.username || parsed.password) throw new UrlBlockedError(raw, 'URLs with credentials are not allowed');
  const host = hostOfUrl(raw)!;
  const privateMsg = `"${host}" is on a private/internal network — web_fetch may only reach the public internet`;
  if (/^sandbox-[0-9a-f]{10}$/.test(host)) throw new UrlBlockedError(raw, `"${host}" is a sandbox preview address — only the browser can reach it: use preview_sandbox, then browser_open`);
  if (host === 'localhost' || INTERNAL_SUFFIXES.some(s => host.endsWith(s))) throw new UrlBlockedError(raw, privateMsg);
  if (isIP(host) && isPrivateAddress(host)) throw new UrlBlockedError(raw, privateMsg);
  return parsed;
}
