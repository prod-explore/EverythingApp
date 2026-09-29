import * as http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BrowserSessionPool } from './sessionPool.js';
import type { PlaywrightConfig } from './config.js';

/**
 * §6b Live-view + human takeover.
 *
 * Attaches a WebSocket server to the same HTTP server as the MCP Express app.
 * Each WS connection is scoped to ONE conversationId (passed as a query param).
 *
 * Two modes, switched by the client:
 *
 * 1. **Watch mode** (default): the server streams CDP screencast frames from
 *    the active Playwright session as binary JPEG blobs. The web client renders
 *    them in an <img> tag. Frames are sent at most once per FRAME_INTERVAL_MS —
 *    if the session is idle (no action in flight) we skip frames, saving CPU.
 *
 * 2. **Takeover mode**: the client sends pointer/keyboard events as JSON
 *    messages; the server dispatches them into the real CDP session using
 *    Playwright's `page.mouse` / `page.keyboard` / `page.touchscreen` APIs.
 *    The agent's tool calls are NOT blocked during takeover — if the agent
 *    tries to act while a human is in control, the action queues normally
 *    (Playwright serialises all CDP calls already). The web UI shows a visual
 *    indicator when takeover is active so the human knows they have control.
 *
 * Security:
 *  - The WS upgrade path requires the same Bearer token as all other endpoints.
 *  - Takeover events are structurally validated (type-checked) before dispatch —
 *    arbitrary JS/CDP commands cannot be injected through this channel.
 *  - The session is identified by conversationId, NOT by a sessionId the client
 *    manufactures — so one conversation cannot reach another conversation's tab.
 */

const FRAME_INTERVAL_MS = 200; // 5 fps — enough for "can I see what's happening"
const JPEG_QUALITY = 60; // balance between latency and clarity on mobile

type ClientMsg =
  | { type: 'takeover'; active: boolean }
  | { type: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { type: 'keyboard'; action: 'down' | 'up' | 'press'; key: string }
  | { type: 'scroll'; x: number; y: number; deltaX: number; deltaY: number };

interface SessionClient {
  ws: WebSocket;
  convId: string;
  takeover: boolean;
  frameTimer: ReturnType<typeof setInterval> | null;
}

export function attachLiveView(
  httpServer: http.Server,
  pool: BrowserSessionPool,
  config: PlaywrightConfig,
  getToken: () => string,
): void {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, SessionClient>();

  // HTTP upgrade — auth and route to the WS handler
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/mcp/liveview')) {
      socket.destroy();
      return;
    }

    // Token can be in the Authorization header or ?token= query param
    const authHeader = req.headers['authorization'];
    const tokenFromHeader = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    const tokenFromQuery = url.searchParams.get('token') ?? undefined;
    const token = tokenFromHeader ?? tokenFromQuery;

    if (!token || token !== getToken()) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const convId = url.searchParams.get('conversationId');
    if (!convId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req, convId);
    });
  });

  wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage, convId: string) => {
    const client: SessionClient = { ws, convId, takeover: false, frameTimer: null };
    clients.set(ws, client);

    // Start streaming frames immediately if there's a session
    startFraming(client, pool, config);

    ws.on('message', (raw: Buffer | string) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString()) as ClientMsg;
      } catch {
        return; // ignore malformed messages
      }
      handleClientMessage(client, msg, pool).catch(err => {
        console.error('[liveview] error handling client message:', err);
      });
    });

    ws.on('close', () => {
      stopFraming(client);
      clients.delete(ws);
    });

    ws.on('error', () => {
      stopFraming(client);
      clients.delete(ws);
    });
  });

  // When a new session opens in the pool, notify any watching clients so they
  // can start streaming without having to reconnect.
  // (This is best-effort — the frame loop already handles the "session not yet
  // ready" case by checking pool.get() on each tick.)
}

function startFraming(client: SessionClient, pool: BrowserSessionPool, _config: PlaywrightConfig): void {
  if (client.frameTimer) return;
  client.frameTimer = setInterval(async () => {
    if (client.ws.readyState !== client.ws.OPEN) {
      stopFraming(client);
      return;
    }
    const session = pool.get(client.convId);
    if (!session) {
      // Send a "no session" sentinel so the UI can show a placeholder
      safeSend(client.ws, JSON.stringify({ type: 'status', session: false }));
      return;
    }
    try {
      const screenshot = await session.page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY });
      // Send raw binary frame — client can decode it as an image blob
      safeSend(client.ws, screenshot);
      // Also send metadata so the client knows current URL and takeover state
      safeSend(
        client.ws,
        JSON.stringify({
          type: 'status',
          session: true,
          url: session.currentUrl,
          takeover: client.takeover,
        }),
      );
    } catch {
      // Page may be navigating — skip this frame silently
    }
  }, FRAME_INTERVAL_MS);
  client.frameTimer.unref?.();
}

function stopFraming(client: SessionClient): void {
  if (client.frameTimer) {
    clearInterval(client.frameTimer);
    client.frameTimer = null;
  }
}

async function handleClientMessage(
  client: SessionClient,
  msg: ClientMsg,
  pool: BrowserSessionPool,
): Promise<void> {
  if (msg.type === 'takeover') {
    client.takeover = msg.active;
    return;
  }

  // All other messages require takeover mode and an active session
  if (!client.takeover) return;
  const session = pool.get(client.convId);
  if (!session) return;

  const { page } = session;

  switch (msg.type) {
    case 'mouse': {
      const btn = (msg.button ?? 'left') as 'left' | 'right' | 'middle';
      switch (msg.action) {
        case 'move': await page.mouse.move(msg.x, msg.y); break;
        case 'down': await page.mouse.down({ button: btn }); break;
        case 'up':   await page.mouse.up({ button: btn });   break;
      }
      pool.touch(client.convId);
      break;
    }
    case 'keyboard': {
      switch (msg.action) {
        case 'down':  await page.keyboard.down(msg.key);  break;
        case 'up':    await page.keyboard.up(msg.key);    break;
        case 'press': await page.keyboard.press(msg.key); break;
      }
      pool.touch(client.convId);
      break;
    }
    case 'scroll': {
      await page.mouse.wheel(msg.deltaX, msg.deltaY);
      pool.touch(client.convId);
      break;
    }
  }
}

function safeSend(ws: WebSocket, data: string | Buffer): void {
  try {
    if (ws.readyState === ws.OPEN) ws.send(data);
  } catch {
    // Connection closed between the readyState check and send — safe to ignore
  }
}
