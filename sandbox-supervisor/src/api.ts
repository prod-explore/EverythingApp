import express from 'express';
import {
  claimForConversation,
  releaseConversation,
  touchConversation,
  getPoolStatus,
  isClaimedContainer,
} from './pool.js';
import { execInContainer, ensureConvWorkspace } from './docker.js';

export function createSupervisorApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // POST /claim { conversationId }
  // MCP server calls this before each tool execution.
  // Returns the same container for the same conversationId (sticky lease).
  app.post('/claim', async (req, res) => {
    const { conversationId } = req.body as { conversationId?: string };
    if (!conversationId || typeof conversationId !== 'string') {
      res.status(400).json({ error: 'conversationId is required' });
      return;
    }

    try {
      const { containerId, isNew } = claimForConversation(conversationId);

      // Ensure per-conversation workspace directory exists (idempotent).
      const workspacePath = await ensureConvWorkspace(containerId, conversationId);

      res.json({ containerId, workspacePath, isNew });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(503).json({ error: message });
    }
  });

  // POST /release { conversationId }
  // Explicitly release a conversation's lease. The container is reset async;
  // we respond immediately so the caller doesn't wait for the scrub.
  app.post('/release', (req, res) => {
    const { conversationId } = req.body as { conversationId?: string };
    if (!conversationId || typeof conversationId !== 'string') {
      res.status(400).json({ error: 'conversationId is required' });
      return;
    }
    releaseConversation(conversationId).catch(err =>
      console.error('[api] release error:', err),
    );
    res.json({ ok: true });
  });

  // POST /exec/:containerId — run a command inside a claimed container.
  // This is the critical security boundary: sandbox-mcp never holds docker.sock.
  // It sends commands here; we validate the container is known before executing.
  app.post('/exec/:containerId', async (req, res) => {
    const { containerId } = req.params;
    const { command, timeoutMs, conversationId } = req.body as {
      command?: string;
      timeoutMs?: number;
      conversationId?: string;
    };

    if (!containerId || !command) {
      res.status(400).json({ error: 'containerId and command are required' });
      return;
    }

    // The container must be in a claimed state — this prevents anything that can
    // reach 127.0.0.1:3001 from running commands in an arbitrary/unclaimed container.
    if (!isClaimedContainer(containerId)) {
      res.status(404).json({ error: 'Unknown or unclaimed containerId' });
      return;
    }

    const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 30_000;

    try {
      const result = await execInContainer(containerId, command, timeout);

      // Record activity to keep the idle watchdog from reclaiming this container.
      if (conversationId) touchConversation(conversationId);

      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /health — used by docker-compose healthcheck and the MCP server's health endpoint.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', pool: getPoolStatus() });
  });

  return app;
}
