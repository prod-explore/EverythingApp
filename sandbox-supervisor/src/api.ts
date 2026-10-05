import express from 'express';
import { SandboxManager } from './sandboxes.js';
import { TerminalManager } from './terminals.js';

const MAX_TIMEOUT_MS = 30 * 60_000;

export function createSupervisorApp(sandboxes: SandboxManager, defaultTimeoutMs = 30_000): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  const ownerOf = (body: { ownerId?: unknown; conversationId?: unknown }): string | undefined => {
    // `conversationId` is the pre-N3 name; a chat without a project is its own owner.
    const v = body.ownerId ?? body.conversationId;
    return typeof v === 'string' && SandboxManager.validOwner(v) ? v : undefined;
  };

  // POST /claim { ownerId } — make sure the owner's sandbox is running. Sticky: same owner, same container.
  app.post('/claim', async (req, res) => {
    const ownerId = ownerOf(req.body ?? {});
    if (!ownerId) {
      res.status(400).json({ error: 'ownerId is required (letters, digits, _ and -, max 64)' });
      return;
    }
    try {
      res.json(await sandboxes.claim(ownerId));
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /release { ownerId } — stop the sandbox now. The workspace volume is never deleted.
  app.post('/release', async (req, res) => {
    const ownerId = ownerOf(req.body ?? {});
    if (!ownerId) {
      res.status(400).json({ error: 'ownerId is required' });
      return;
    }
    res.json({ ok: true, stopped: await sandboxes.stop(ownerId) });
  });

  // POST /terminal/run { ownerId, terminal?, command, timeoutMs? }
  app.post('/terminal/run', async (req, res) => {
    const { terminal, command, timeoutMs } = (req.body ?? {}) as { terminal?: unknown; command?: unknown; timeoutMs?: unknown };
    const ownerId = ownerOf(req.body ?? {});
    if (!ownerId || typeof command !== 'string' || !command.trim()) {
      res.status(400).json({ error: 'ownerId and a non-empty command are required' });
      return;
    }
    if (terminal !== undefined && (typeof terminal !== 'string' || !TerminalManager.validName(terminal))) {
      res.status(400).json({ error: 'invalid terminal name (letters, digits, _ and -, max 32)' });
      return;
    }
    const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : defaultTimeoutMs;
    try {
      res.json(await sandboxes.run(ownerId, terminal as string | undefined, command, timeout));
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /terminals?ownerId=
  app.get('/terminals', (req, res) => {
    const ownerId = typeof req.query['ownerId'] === 'string' ? req.query['ownerId'] : '';
    if (!SandboxManager.validOwner(ownerId)) {
      res.status(400).json({ error: 'ownerId is required' });
      return;
    }
    res.json({ terminals: sandboxes.listTerminals(ownerId) });
  });

  // POST /terminal/close { ownerId, terminal }
  app.post('/terminal/close', async (req, res) => {
    const ownerId = ownerOf(req.body ?? {});
    const terminal = (req.body ?? {}).terminal;
    if (!ownerId || typeof terminal !== 'string') {
      res.status(400).json({ error: 'ownerId and terminal are required' });
      return;
    }
    res.json({ closed: await sandboxes.closeTerminal(ownerId, terminal) });
  });

  // POST /exec/:containerId — one-shot command (git_op, read_log). Only reaches a RUNNING, supervisor-managed
  // sandbox, so nothing that can reach this port can run commands in an arbitrary container.
  app.post('/exec/:containerId', async (req, res) => {
    const { command, timeoutMs } = (req.body ?? {}) as { command?: unknown; timeoutMs?: unknown };
    if (typeof command !== 'string' || !command) {
      res.status(400).json({ error: 'command is required' });
      return;
    }
    const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : defaultTimeoutMs;
    try {
      res.json(await sandboxes.exec(req.params['containerId']!, command, timeout));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(/Unknown or stopped/.test(message) ? 404 : 500).json({ error: message });
    }
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ...sandboxes.status() });
  });

  return app;
}
