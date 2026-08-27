import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Config } from './config.js';
import { SupervisorClient } from './supervisor-client.js';
import { registerAllTools } from './tools/index.js';

// ─── Auth ────────────────────────────────────────────────────────────────────

function extractToken(req: express.Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.split(' ')[1];
  const q = req.query['token'];
  if (typeof q === 'string') return q;
  return undefined;
}

function requireAuth(
  config: Config,
  req: express.Request,
  res: express.Response,
): boolean {
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

// ─── SSE session tracking (legacy transport) ─────────────────────────────────

interface SseSession {
  transport: SSEServerTransport;
  server: McpServer;
  createdAt: number;
}

// ─── App factory ─────────────────────────────────────────────────────────────

function createMcpServer(config: Config, supervisor: SupervisorClient): McpServer {
  const server = new McpServer(
    { name: 'sandbox-mcp', version: '0.1.0' },
    {
      instructions:
        'You have access to a sandboxed bash environment and git. ' +
        'Every command you run is logged and requires explicit approval. ' +
        'Use read_log to audit what has already been executed in this session.',
    },
  );
  registerAllTools(server, config, supervisor);
  return server;
}

export function createApp(config: Config, supervisor: SupervisorClient): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  const sseSessions = new Map<string, SseSession>();

  // Suppress OAuth discovery probes from MCP clients
  app.get(/^\/\.well-known\/oauth-.*/, (_req, res) => res.status(404).end());

  // ── Streamable HTTP (stateless — Antigravity, Cursor, etc.) ──
  // Each POST creates a fresh server+transport, handles the request, tears down.
  app.post('/mcp/sse', async (req, res) => {
    if (!requireAuth(config, req, res)) return;
    try {
      const server = createMcpServer(config, supervisor);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] Streamable HTTP error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Legacy SSE (Claude Desktop) ──
  app.get('/mcp/sse', async (req, res) => {
    if (!requireAuth(config, req, res)) return;
    const transport = new SSEServerTransport('/mcp/messages', res);
    const server = createMcpServer(config, supervisor);
    await server.connect(transport);
    sseSessions.set(transport.sessionId, { transport, server, createdAt: Date.now() });
    res.on('close', async () => {
      sseSessions.delete(transport.sessionId);
      await server.close().catch(() => {});
    });
  });

  app.post('/mcp/messages', async (req, res) => {
    const id = req.query['sessionId'];
    if (typeof id !== 'string') {
      res.status(400).send('Missing sessionId');
      return;
    }
    const session = sseSessions.get(id);
    if (!session) {
      res.status(404).send('Session not found');
      return;
    }
    await session.transport.handlePostMessage(req, res, req.body);
  });

  // ── Health ──
  app.get('/mcp/health', async (req, res) => {
    if (!requireAuth(config, req, res)) return;
    try {
      const supervisorHealth = await supervisor.health();
      res.json({ status: 'ok', supervisor: supervisorHealth });
    } catch (err) {
      res.status(502).json({ status: 'error', error: String(err) });
    }
  });

  return app;
}
