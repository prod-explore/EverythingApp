import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { attachLiveViewProxy } from '../liveview-proxy.js';

const APP_TOKEN = 'app-token';
const UPSTREAM_KEY = 'upstream-key';

let upstream: http.Server;
let proxy: http.Server;
let proxyPort: number;
let seen: { url?: string; headers?: http.IncomingHttpHeaders } = {};

const listen = (s: http.Server) => new Promise<number>(r => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

before(async () => {
  upstream = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  upstream.on('upgrade', (req, socket) => {
    seen = { url: req.url, headers: req.headers };
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: abc\r\n\r\n');
    socket.on('data', d => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
    socket.on('end', () => socket.end());
    socket.on('error', () => {});
  });
  const upstreamPort = await listen(upstream);

  proxy = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachLiveViewProxy(proxy, { upstreamUrl: `http://127.0.0.1:${upstreamPort}/ignored/path`, upstreamApiKey: UPSTREAM_KEY, authToken: APP_TOKEN, isCookieValid: c => c?.includes('ea_session=good') ?? false });
  proxyPort = await listen(proxy);
});

after(() => {
  for (const s of [proxy, upstream]) { s.closeAllConnections(); s.close(); }
});

const wsHeaders = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' };

function connect(path: string, extra: http.OutgoingHttpHeaders = {}): Promise<{ status: number; socket?: import('node:net').Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path, agent: false, headers: { ...wsHeaders, ...extra } });
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on('response', res => { res.resume(); resolve({ status: res.statusCode ?? 0 }); });
    req.on('error', reject);
    req.end();
  });
}

describe('live-view WebSocket proxy', () => {
  it('rejects a missing or wrong token with 401 and never contacts upstream', async () => {
    seen = {};
    assert.equal((await connect('/api/liveview?conversationId=c1')).status, 401);
    assert.equal((await connect('/api/liveview?conversationId=c1&token=nope')).status, 401);
    assert.equal(seen.url, undefined);
  });

  it('accepts a valid session cookie (same-origin or no Origin) without any token in the URL', async () => {
    const noOrigin = await connect('/api/liveview?conversationId=c1', { Cookie: 'ea_session=good' });
    assert.equal(noOrigin.status, 101);
    noOrigin.socket!.destroy();
    const same = await connect('/api/liveview?conversationId=c1', { Cookie: 'ea_session=good', Origin: `http://127.0.0.1:${proxyPort}` });
    assert.equal(same.status, 101);
    same.socket!.destroy();
  });

  it('refuses a session cookie on a cross-origin handshake (403) and an invalid cookie (401)', async () => {
    seen = {};
    assert.equal((await connect('/api/liveview?conversationId=c1', { Cookie: 'ea_session=good', Origin: 'https://evil.example' })).status, 403);
    assert.equal((await connect('/api/liveview?conversationId=c1', { Cookie: 'ea_session=bad' })).status, 401);
    assert.equal(seen.url, undefined);
  });

  it('requires a conversationId', async () => {
    assert.equal((await connect(`/api/liveview?token=${APP_TOKEN}`)).status, 400);
  });

  it('relays bytes both ways after the 101 handshake', async () => {
    const { status, socket } = await connect(`/api/liveview?conversationId=c1&token=${APP_TOKEN}`);
    assert.equal(status, 101);
    const reply = await new Promise<string>(resolve => {
      socket!.once('data', d => resolve(d.toString()));
      socket!.write('hello');
    });
    assert.equal(reply, 'echo:hello');
    socket!.destroy();
  });

  it('sends the server-side key upstream, never the user token, cookie or origin', async () => {
    seen = {};
    const { socket } = await connect(`/api/liveview?conversationId=${encodeURIComponent('a b')}&token=${APP_TOKEN}`, { Cookie: 'sid=1', Origin: 'https://evil.example' });
    socket!.destroy();
    assert.equal(seen.url, '/mcp/liveview?conversationId=a%20b');
    assert.equal(seen.headers?.authorization, `Bearer ${UPSTREAM_KEY}`);
    assert.equal(seen.headers?.cookie, undefined);
    assert.equal(seen.headers?.origin, undefined);
    assert.ok(!JSON.stringify(seen.headers).includes(APP_TOKEN), 'the app token must not reach playwright-mcp');
  });

  it('accepts the token as a Bearer header too (non-browser clients)', async () => {
    const { status, socket } = await connect('/api/liveview?conversationId=c1', { Authorization: `Bearer ${APP_TOKEN}` });
    assert.equal(status, 101);
    socket!.destroy();
  });

  it('closes unknown upgrade paths', async () => {
    await assert.rejects(connect(`/other?token=${APP_TOKEN}`));
  });

  it('answers 503 when playwright-mcp is not configured', async () => {
    const bare = http.createServer();
    attachLiveViewProxy(bare, { authToken: APP_TOKEN });
    const port = await listen(bare);
    const status = await new Promise<number>(resolve => {
      const r = http.request({ host: '127.0.0.1', port, path: `/api/liveview?conversationId=c&token=${APP_TOKEN}`, agent: false, headers: wsHeaders });
      r.on('response', res => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on('upgrade', () => resolve(101));
      r.on('error', () => resolve(-1));
      r.end();
    });
    bare.closeAllConnections(); bare.close();
    assert.equal(status, 503);
  });

  it('answers 502 when upstream is unreachable', async () => {
    const dead = http.createServer();
    attachLiveViewProxy(dead, { authToken: APP_TOKEN, upstreamUrl: 'http://127.0.0.1:1', upstreamApiKey: 'k' });
    const port = await listen(dead);
    const status = await new Promise<number>(resolve => {
      const r = http.request({ host: '127.0.0.1', port, path: `/api/liveview?conversationId=c&token=${APP_TOKEN}`, agent: false, headers: wsHeaders });
      r.on('response', res => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on('error', () => resolve(-1));
      r.end();
    });
    dead.closeAllConnections(); dead.close();
    assert.equal(status, 502);
  });
});

describe('live-view proxy — half-closed peers', () => {
  it('tears the connection down when the client disconnects and the upstream never closes back', async () => {
    const upstreamSockets: import('node:stream').Duplex[] = [];
    const stubborn = http.createServer();
    stubborn.on('upgrade', (_req, socket) => {
      upstreamSockets.push(socket);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: abc\r\n\r\n');
      socket.resume(); // reads, but deliberately never answers the client's FIN
      socket.on('error', () => {});
    });
    const upPort = await listen(stubborn);
    const front = http.createServer();
    attachLiveViewProxy(front, { authToken: APP_TOKEN, upstreamUrl: `http://127.0.0.1:${upPort}`, upstreamApiKey: 'k' });
    const port = await listen(front);

    const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: `/api/liveview?conversationId=c&token=${APP_TOKEN}`, agent: false, headers: wsHeaders });
      r.on('upgrade', (_res, s) => resolve(s));
      r.on('error', reject);
      r.end();
    });
    socket.resume();
    const closedByProxy = new Promise<void>(resolve => socket.on('close', () => resolve()));
    socket.end(); // FIN only — a browser tab closing without a WebSocket close handshake
    try {
      // Without the grace teardown the proxy would keep this connection (and its upstream socket) open forever.
      await Promise.race([
        closedByProxy,
        new Promise((_, reject) => setTimeout(() => reject(new Error('proxy kept a half-closed connection open')), 6000)),
      ]);
    } finally {
      for (const s of upstreamSockets) s.destroy();
      stubborn.closeAllConnections(); stubborn.close();
      front.closeAllConnections(); front.close();
    }
  });

  it('accepts a valid session cookie without any token in the URL', async () => {
    const { status, socket } = await connect('/api/liveview?conversationId=c1', { Cookie: 'ea_session=good' });
    assert.equal(status, 101);
    socket!.destroy();
  });

  it('accepts a cookie from a same-origin page but refuses it from another origin (cross-site WebSocket hijacking)', async () => {
    seen = {};
    const same = await connect('/api/liveview?conversationId=c1', { Cookie: 'ea_session=good', Origin: `http://127.0.0.1:${proxyPort}` });
    assert.equal(same.status, 101);
    same.socket!.destroy();
    seen = {};
    assert.equal((await connect('/api/liveview?conversationId=c1', { Cookie: 'ea_session=good', Origin: 'https://evil.example' })).status, 403);
    assert.equal(seen.url, undefined);
  });

  it('rejects an invalid cookie when no token is supplied', async () => {
    assert.equal((await connect('/api/liveview?conversationId=c1', { Cookie: 'ea_session=bad' })).status, 401);
  });
});
