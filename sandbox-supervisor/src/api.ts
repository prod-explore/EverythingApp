import express from 'express';
import { claimContainer, releaseContainer, getPoolStatus, isClaimedContainer } from './pool.js';
import { execInContainer } from './docker.js';

export function createSupervisorApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // POST /claim — MCP server calls this before each tool execution
  app.post('/claim', (_req, res) => {
    try {
      const containerId = claimContainer();
      res.json({ containerId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(503).json({ error: message });
    }
  });

  // POST /release/:containerId — MCP server calls this after each tool execution
  app.post('/release/:containerId', (req, res) => {
    const { containerId } = req.params;
    if (!containerId) {
      res.status(400).json({ error: 'containerId is required' });
      return;
    }
    // Release is async but we respond immediately — the MCP server doesn't
    // need to wait for the container to be scrubbed before returning to the client.
    releaseContainer(containerId).catch(err =>
      console.error('[api] release error:', err),
    );
    res.json({ ok: true });
  });

  // POST /exec/:containerId — run a command inside a claimed container.
  // This is the critical security boundary: sandbox-mcp never holds docker.sock.
  // It sends commands here; we validate the container is known before executing.
  app.post('/exec/:containerId', async (req, res) => {
    const { containerId } = req.params;
    const { command, timeoutMs } = req.body as { command?: string; timeoutMs?: number };

    if (!containerId || !command) {
      res.status(400).json({ error: 'containerId and command are required' });
      return;
    }

    // The comment above claimed this was already validated — it wasn't.
    // Without this check, anything that can reach 127.0.0.1:3001 could run
    // commands in an arbitrary/unclaimed container id, bypassing the whole
    // claim/release accounting this supervisor exists to enforce.
    if (!isClaimedContainer(containerId)) {
      res.status(404).json({ error: 'Unknown or unclaimed containerId' });
      return;
    }

    const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 30_000;

    try {
      const result = await execInContainer(containerId, command, timeout);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /health — used by docker-compose healthcheck and the MCP server's own health endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', pool: getPoolStatus() });
  });

  return app;
}
