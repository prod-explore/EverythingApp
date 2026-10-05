import express from 'express';
import { HttpError, SandboxManager } from './sandboxes.js';
import { TerminalManager } from './terminals.js';

const MAX_TIMEOUT_MS = 30 * 60_000;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const statusOf = (err: unknown, fallback: number) => (err instanceof HttpError ? err.status : fallback);

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
      res.status(statusOf(err, 503)).json({ error: messageOf(err) });
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
      // 429 = terminal limit reached (close one first), 503 = sandbox capacity / docker trouble.
      res.status(statusOf(err, 503)).json({ error: messageOf(err) });
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
      res.status(statusOf(err, 500)).json({ error: messageOf(err) });
    }
  });

  // ─── /sandboxes/:owner/* — per-project resources (explorer, checkpoints, lifecycle) ───────────────

  const owners = express.Router({ mergeParams: true });
  app.use('/sandboxes/:owner', (req, res, next) => {
    if (!SandboxManager.validOwner(req.params['owner'] ?? '')) {
      res.status(400).json({ error: 'invalid owner id (letters, digits, _ and -, max 64)' });
      return;
    }
    next();
  }, owners);

  type Handler = (req: express.Request<{ owner: string }>, res: express.Response) => Promise<void> | void;
  const wrap = (fn: Handler): express.RequestHandler<{ owner: string }> => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const status = statusOf(err, 500);
      if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl}:`, err);
      if (!res.headersSent) res.status(status).json({ error: messageOf(err) });
    }
  };

  // GET /sandboxes/:owner — status of one sandbox (running, idle, cpu, warnings, terminals). sandbox=null if unknown.
  owners.get('/', wrap((req, res) => void res.json({ sandbox: sandboxes.sandboxStatus(req.params.owner) })));

  // GET /sandboxes/:owner/files?path=/workspace/sub — directory listing (read-only, does not start the sandbox).
  owners.get(
    '/files',
    wrap(async (req, res) => {
      res.json(await sandboxes.listFiles(req.params.owner, req.query['path']));
    }),
  );

  // GET /sandboxes/:owner/file?path=/workspace/a.txt — raw bytes, capped (413 above the cap).
  owners.get(
    '/file',
    wrap(async (req, res) => {
      const f = await sandboxes.readFile(req.params.owner, req.query['path']);
      res.setHeader('Content-Type', f.mime);
      res.setHeader('Content-Length', String(f.data.length));
      res.setHeader('X-File-Path', encodeURIComponent(f.path));
      res.setHeader('X-File-Size', String(f.size));
      // Agent-written content: never let a browser sniff or run it if this response is ever opened directly.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
      res.setHeader('Cache-Control', 'no-store');
      res.end(f.data);
    }),
  );

  // POST /sandboxes/:owner/checkpoint { label } — git snapshot of /workspace, taken inside the sandbox.
  owners.post(
    '/checkpoint',
    wrap(async (req, res) => {
      res.json(await sandboxes.checkpoint(req.params.owner, (req.body ?? {}).label));
    }),
  );

  // GET /sandboxes/:owner/checkpoints — newest first.
  owners.get(
    '/checkpoints',
    wrap(async (req, res) => {
      res.json({ checkpoints: await sandboxes.listCheckpoints(req.params.owner) });
    }),
  );

  // POST /sandboxes/:owner/rollback { checkpointId }
  owners.post(
    '/rollback',
    wrap(async (req, res) => {
      res.json({ ok: true, ...(await sandboxes.rollback(req.params.owner, (req.body ?? {}).checkpointId)) });
    }),
  );

  // DELETE /sandboxes/:owner/volume — project deletion: removes the container AND the workspace volume.
  owners.delete(
    '/volume',
    wrap(async (req, res) => {
      res.json({ ok: true, ...(await sandboxes.destroy(req.params.owner)) });
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ...sandboxes.status() });
  });

  return app;
}
