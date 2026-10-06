import * as http from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';

/**
 * Same-origin proxy for the browser live view (audit bug #6).
 *
 * The UI used to open a WebSocket straight to playwright-mcp's port, composed from a build-time
 * VITE_ env var: a second origin (blocked by the page's CSP once it is served by this app, mixed
 * content behind HTTPS, one more port to expose) and the browser had to be handed playwright-mcp's
 * API key. Now the page connects to  wss://<this-host>/api/liveview  and this server — which
 * already authenticates the user — relays the WebSocket to playwright-mcp with the server-side key.
 *
 * It is a raw HTTP-upgrade relay: after the 101 handshake the two sockets are piped, so frames
 * (binary JPEG screencast, JSON takeover events) pass through untouched and no WS library is needed.
 */

export const LIVEVIEW_PATH = '/api/liveview';

export interface LiveViewProxyOptions {
  /** Base URL of playwright-mcp, e.g. http://playwright-mcp:3003 (any path is ignored). Unset = feature off (503). */
  upstreamUrl?: string;
  /** playwright-mcp's API key — sent upstream as a Bearer header, never exposed to the browser. */
  upstreamApiKey?: string;
  /** The app's own token (same one the REST API / SSE use). */
  authToken: string;
  /** Browser session check (the HttpOnly cookie rides along on the WebSocket upgrade). */
  isCookieValid?: (cookieHeader: string | undefined) => boolean;
  /** Handshake + idle safety net. Default 15 s for the upstream handshake. */
  handshakeTimeoutMs?: number;
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

// Headers that describe the client↔proxy hop or carry the user's credentials — never forwarded upstream.
const DROP_REQUEST_HEADERS = new Set(['host', 'authorization', 'cookie', 'origin', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip']);

export function attachLiveViewProxy(server: http.Server, opts: LiveViewProxyOptions): void {
  const upstream = opts.upstreamUrl ? new URL(opts.upstreamUrl) : null;

  server.on('upgrade', (req, clientSocket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== LIVEVIEW_PATH) {
      // This server has no other WebSocket endpoints.
      clientSocket.destroy();
      return;
    }

    // Auth: browsers cannot set headers on a WebSocket, so the token travels as ?token= (same as SSE).
    const header = req.headers.authorization;
    const supplied = header?.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('token') ?? undefined);
    const cookieOk = opts.isCookieValid?.(req.headers.cookie) ?? false;
    if (cookieOk && req.headers.origin) {
      // Cookies ride along on cross-site WebSocket handshakes too — only same-origin pages may use them.
      let sameOrigin = false;
      try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { /* malformed Origin */ }
      if (!sameOrigin) return reject(clientSocket, '403 Forbidden');
    }
    if (!cookieOk && !tokenMatches(supplied, opts.authToken)) return reject(clientSocket, '401 Unauthorized');

    const conversationId = url.searchParams.get('conversationId');
    if (!conversationId) return reject(clientSocket, '400 Bad Request');
    if (!upstream || !opts.upstreamApiKey) return reject(clientSocket, '503 Service Unavailable');

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!DROP_REQUEST_HEADERS.has(k) && v !== undefined) headers[k] = v;
    }
    headers['host'] = upstream.host;
    headers['authorization'] = `Bearer ${opts.upstreamApiKey}`;

    const upstreamReq = http.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      agent: false, // an upgraded connection must never enter (or be reused from) a keep-alive pool
      path: `/mcp/liveview?conversationId=${encodeURIComponent(conversationId)}`,
      headers,
      timeout: opts.handshakeTimeoutMs ?? 15_000,
    });

    const abort = (status: string) => {
      upstreamReq.destroy();
      reject(clientSocket, status);
    };

    upstreamReq.on('timeout', () => abort('504 Gateway Timeout'));
    upstreamReq.on('error', () => abort('502 Bad Gateway'));

    // Upstream refused the upgrade (bad key, unknown path…): report a generic gateway error, not its body.
    upstreamReq.on('response', res => {
      res.resume();
      abort(res.statusCode === 401 || res.statusCode === 403 ? '502 Bad Gateway' : `${res.statusCode ?? 502} Upstream Error`);
    });

    upstreamReq.on('upgrade', (res, upstreamSocket, upstreamHead) => {
      upstreamReq.setTimeout(0);
      const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
      for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
      clientSocket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upstreamHead.length) clientSocket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);

      const close = () => {
        upstreamSocket.destroy();
        clientSocket.destroy();
      };
      upstreamSocket.on('error', close);
      clientSocket.on('error', close);
      upstreamSocket.on('close', close);
      clientSocket.on('close', close);
      // HTTP-upgrade sockets are half-open capable: when one side sends FIN, pipe() forwards it, but a
      // peer that never closes back would leave both sockets (and their fds) hanging forever. A
      // WebSocket has no useful half-closed state, so after the first FIN give the peer a short grace
      // period to flush and close, then tear both down.
      const grace = () => setTimeout(close, 2000).unref();
      upstreamSocket.on('end', grace);
      clientSocket.on('end', grace);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });

    upstreamReq.end();
  });
}
