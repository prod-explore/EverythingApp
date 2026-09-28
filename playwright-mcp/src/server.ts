import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { PlaywrightConfig } from './config.js';
import { registerAllTools } from './tools/index.js';
import { BrowserSessionPool, ChromiumLauncher } from './sessionPool.js';

function extractToken(req: express.Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.split(' ')[1];
  const q = req.query['token'];
  if (typeof q === 'string') return q;
  return undefined;
}

function requireAuth(config: PlaywrightConfig, req: express.Request, res: express.Response): boolean {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized: missing token' });
    return false;
  }
  if (token !== config.apiKey) {
    res.status(403).json({ error: 'Forbidden: invalid API key' });
    return false;
  }
  return true;
}

function createMcpServer(config: PlaywrightConfig, pool: BrowserSessionPool): McpServer {
  const server = new McpServer(
    { name: 'playwright-mcp', version: '0.2.0' },
    {
      instructions:
        'You have access to controlled web browsing tools. ' +
        'Raw page content is NEVER passed to you directly — it passes through a quarantine layer ' +
        'that summarizes it and lists interactive elements. Be specific about what you want. ' +
        'Use browse_url for a single one-shot fact from a page. Use browser_open/browser_observe/' +
        'browser_act/browser_close for a multi-step task that needs to click, type, or navigate — ' +
        'the session (including login state) persists across calls until you close it or it idles out. ' +
        'All of these require approval before execution.',
    },
  );
  registerAllTools(server, config, pool);
  return server;
}

export function createApp(config: PlaywrightConfig): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  const sseSessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

  // One pool for the whole process — NOT per MCP connection. The streamable HTTP
  // transport below is stateless (a fresh McpServer per POST), so the sticky
  // per-conversation session guarantee lives in the pool, not in any one transport.
  const pool = new BrowserSessionPool({
    maxSessions: config.maxSessions,
    idleTimeoutMs: config.sessionIdleTimeoutMs,
    watchdogIntervalMs: config.watchdogIntervalMs,
    makeLauncher: sessionId => new ChromiumLauncher(config.profileDir, sessionId),
  });

  app.get(/^\/\.well-known\/oauth-.*/, (_req, res) => res.status(404).end());

  // Streamable HTTP (stateless)
  app.post('/mcp/sse', async (req, res) => {
    if (!requireAuth(config, req, res)) return;
    try {
      const server = createMcpServer(config, pool);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[playwright-mcp] Streamable HTTP error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Legacy SSE (Claude Desktop)
  app.get('/mcp/sse', async (req, res) => {
    if (!requireAuth(config, req, res)) return;
    const transport = new SSEServerTransport('/mcp/messages', res);
    const server = createMcpServer(config, pool);
    await server.connect(transport);
    sseSessions.set(transport.sessionId, { transport, server });
    res.on('close', async () => {
      sseSessions.delete(transport.sessionId);
      await server.close().catch(() => {});
    });
  });

  app.post('/mcp/messages', async (req, res) => {
    const id = req.query['sessionId'];
    if (typeof id !== 'string') { res.status(400).send('Missing sessionId'); return; }
    const session = sseSessions.get(id);
    if (!session) { res.status(404).send('Session not found'); return; }
    await session.transport.handlePostMessage(req, res, req.body);
  });

  app.get('/mcp/health', (req, res) => {
    if (!requireAuth(config, req, res)) return;
    res.json({ status: 'ok', service: 'playwright-mcp' });
  });

  // Status of currently open browser sessions — for the web UI's (upcoming) live-view
  // panel to discover what's running for a conversation, and for basic ops visibility.
  // Not the live-view stream itself (that's websocket, added in the next patch).
  app.get('/mcp/browser-sessions', (req, res) => {
    if (!requireAuth(config, req, res)) return;
    res.json(pool.status());
  });

  return app;
}
