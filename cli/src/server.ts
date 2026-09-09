import express from 'express';
import helmet from 'helmet';
import { timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { McpConnection } from './mcp-client.js';
import { ToolRegistry } from './tool-registry.js';
import { WebApprovalGate } from './web-approval.js';
import { runTurn } from './anthropic-loop.js';
import { loadHistory, saveHistory, clearHistory } from './history-store.js';
import { loadPendingBatches, savePendingBatches } from './batch-store.js';
import { submitBatch, checkBatch } from './batch.js';
import { UsageTracker } from './usage-tracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = `Jesteś osobistym asystentem Mikołaja w EverythingApp — jego self-hosted, BYOK
systemie AI, używanym teraz przez przeglądarkę (telefon lub desktop) zamiast terminala. Masz
dostęp do narzędzi wystawionych przez podłączone serwery MCP. Każde wywołanie narzędzia z
efektem ubocznym przechodzi przez Approval Gate na stronie — jeśli zostanie odrzucone,
poinformuj o tym użytkownika i zaproponuj alternatywę zamiast ponawiać to samo wywołanie w
kółko. Odpowiadaj po polsku, konkretnie, bez zbędnego lania wody.`;

/**
 * Constant-time comparison of the Authorization header against the expected
 * bearer token. A plain `===`/`!==` string compare returns as soon as it
 * finds a mismatched byte, so how long it takes leaks how many leading
 * characters were correct — a real (if slow) attack against a long-lived
 * shared secret sitting on the open internet behind Nginx. timingSafeEqual
 * takes the same time regardless of where the mismatch is; the length check
 * before it is the one unavoidable exception (needed because
 * timingSafeEqual throws on unequal-length buffers), and leaks only the
 * correct token's length, not any of its content.
 */
function isValidAuthHeader(header: string | undefined, expectedToken: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${expectedToken}`);
  const actual = Buffer.from(header);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

const BATCH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Deliberately the MVP bridge, not the full §11 PWA spec: one flat
 * conversation (same history.json as the CLI, not a Postgres-backed sidebar
 * of separate threads), one shared auth token (not per-user accounts), no
 * push notifications for backgrounded approvals/batches — the page has to be
 * open and polling. Everything harder (tool registry, approval semantics,
 * batch mode, usage tracking, prompt caching) already exists and is reused
 * as-is from the CLI; this file only swaps the transport.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const authToken = process.env['SERVER_AUTH_TOKEN'];
  if (!authToken) throw new Error('Missing required environment variable: SERVER_AUTH_TOKEN');

  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

  const connections = config.mcpServers.map(cfg => new McpConnection(cfg));
  for (const conn of connections) {
    try {
      await conn.connect();
      console.log(`[mcp] połączono z '${conn.name}'`);
    } catch (err) {
      console.error(`[mcp] nie udało się połączyć z '${conn.name}':`, (err as Error).message);
    }
  }

  const registry = new ToolRegistry(config.autoApproveTools);
  await registry.loadFrom(connections);
  console.log(`[tools] załadowano ${registry.toAnthropicTools().length} narzędzi z MCP`);

  const approvalGate = new WebApprovalGate();
  const usageTracker = new UsageTracker();
  const serverTools: Anthropic.ToolUnion[] = config.webSearchEnabled
    ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
    : [];

  let history: Anthropic.MessageParam[] = await loadHistory();

  /**
   * A turn (one user message → Claude's reply, including any tool calls and
   * the approvals they need) can take anywhere from a second to several
   * minutes — an approval sitting unanswered while the phone is locked is
   * normal, not an edge case. POST /api/message used to await the whole
   * thing and hold the HTTP connection open for all of it; on a phone,
   * backgrounding the tab commonly suspends or kills that connection, and
   * the reply is lost even though the server finished the work.
   *
   * So the turn now runs detached from the request that started it: POST
   * /api/message kicks it off and returns immediately, GET /api/status is
   * polled (same page, same 1.5s interval as pending-approvals) until it
   * reports done/error. Every request completes in well under a second —
   * nothing to time out, on the phone or through Nginx in front of it.
   */
  type TurnState =
    | { id: number; status: 'idle' }
    | { id: number; status: 'running' }
    | { id: number; status: 'done'; lastCost: number }
    | { id: number; status: 'error'; error: string };
  let turnCounter = 0;
  let turnState: TurnState = { id: 0, status: 'idle' };

  async function resolvePendingBatches(): Promise<void> {
    const pending = await loadPendingBatches();
    if (pending.length === 0) return;
    const stillPending = [];
    for (const entry of pending) {
      let resolution;
      try {
        resolution = await checkBatch(anthropic, entry);
      } catch (err) {
        console.error(`[batch] błąd sprawdzania ${entry.batchId}:`, (err as Error).message);
        stillPending.push(entry);
        continue;
      }
      if (!resolution) {
        stillPending.push(entry);
        continue;
      }
      if (resolution.status === 'succeeded' && resolution.text) {
        history.push({ role: 'assistant', content: resolution.text });
        await saveHistory(history);
      }
      // Errored/canceled/expired batches are just dropped from the pending
      // list — surfaced via GET /api/batches while still pending, nothing
      // further to show once resolved with no text.
    }
    await savePendingBatches(stillPending);
  }

  const app = express();
  app.set('trust proxy', 1); // behind Nginx — req.ip/req.protocol reflect the real client, not the proxy hop
  app.use(helmet());
  app.use(express.json());

  // Health check — deliberately outside /api (no auth): this is for Docker's
  // HEALTHCHECK and any future uptime monitoring, not for the app itself.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Single shared secret — every request needs it. Fine for one user; not
  // the per-account auth §11 eventually calls for.
  app.use('/api', (req, res, next) => {
    if (!isValidAuthHeader(req.headers.authorization, authToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  app.get('/api/history', (_req, res) => {
    res.json({ history });
  });

  app.post('/api/clear', async (_req, res) => {
    if (turnState.status === 'running') {
      res.status(409).json({ error: 'poczekaj aż bieżąca wiadomość się przetworzy' });
      return;
    }
    history = [];
    await clearHistory();
    res.json({ ok: true });
  });

  app.get('/api/usage', (_req, res) => {
    res.json({ summary: usageTracker.summary() });
  });

  app.get('/api/pending-approvals', (_req, res) => {
    res.json({ pending: approvalGate.listPending() });
  });

  app.post('/api/approve', (req, res) => {
    const { id, approved, alwaysAllow } = req.body ?? {};
    if (typeof id !== 'string' || typeof approved !== 'boolean') {
      res.status(400).json({ error: 'expected { id: string, approved: boolean, alwaysAllow?: boolean }' });
      return;
    }
    const ok = approvalGate.resolve(id, approved, Boolean(alwaysAllow));
    if (!ok) {
      res.status(404).json({ error: 'no such pending approval (already resolved?)' });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/batches', async (_req, res) => {
    // Skip resolving (not just reporting) while a turn is running — both
    // paths can mutate the shared `history` array, and resolving here too
    // could interleave with a turn's read-then-overwrite of it. Reporting
    // the last-known pending list is still safe and immediate either way.
    if (turnState.status !== 'running') {
      await resolvePendingBatches();
    }
    const pending = await loadPendingBatches();
    res.json({ pending });
  });

  app.post('/api/schedule', async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'expected { text: string }' });
      return;
    }
    try {
      const entry = await submitBatch(anthropic, config.model, SYSTEM_PROMPT, history, text);
      history.push({ role: 'user', content: text });
      await saveHistory(history);
      const pending = await loadPendingBatches();
      await savePendingBatches([...pending, entry]);
      res.json({ ok: true, entry });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Detached: returns as soon as the turn is queued, not when it finishes.
  // Poll GET /api/status for the outcome. Rejects a second message while one
  // is still running rather than racing two turns against the same history.
  app.post('/api/message', (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'expected { text: string }' });
      return;
    }
    if (turnState.status === 'running') {
      res.status(409).json({ error: 'poprzednia wiadomość jeszcze się przetwarza' });
      return;
    }

    turnCounter += 1;
    const thisTurnId = turnCounter;
    const historyBeforeTurn = history;
    // Optimistic: so GET /api/history and /api/status show the sent message
    // right away, even before the turn finishes — including after a reload.
    history = [...history, { role: 'user', content: text }];
    turnState = { id: thisTurnId, status: 'running' };
    res.json({ ok: true, turnId: thisTurnId });

    (async () => {
      let lastCost = 0;
      try {
        const result = await runTurn(
          {
            anthropic,
            model: config.model,
            tools: registry,
            systemPrompt: SYSTEM_PROMPT,
            serverTools,
            confirm: (label, args) => approvalGate.confirm(label, args),
            onUsage: usage => {
              lastCost = usageTracker.record(usage);
            },
          },
          historyBeforeTurn,
          text,
        );
        history = result;
        await saveHistory(history);
        turnState = { id: thisTurnId, status: 'done', lastCost };
      } catch (err) {
        // Roll back the optimistic append — a failed turn shouldn't leave a
        // sent message on screen with no reply and no way to retry it.
        history = historyBeforeTurn;
        turnState = { id: thisTurnId, status: 'error', error: (err as Error).message };
      }
    })();
  });

  app.get('/api/status', (_req, res) => {
    res.json({ ...turnState, history, usage: usageTracker.summary() });
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'chat.html'));
  });

  // Global error handler — must have all 4 params for Express to recognize
  // it as one. Catches JSON-parse failures from express.json() and anything
  // an async route rejects with (Express 5 forwards those automatically),
  // so every error response is JSON like the rest of the API instead of
  // Express's default HTML error page. body-parser's JSON-syntax errors
  // (and any other well-behaved middleware error) carry their own
  // statusCode — a malformed request body is the client's fault (400), not
  // ours (500), so that's respected here rather than flattened to 500.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[server] unhandled error:', err);
    if (res.headersSent) return;
    const statusCode =
      typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number'
        ? err.statusCode
        : 500;
    res.status(statusCode).json({ error: statusCode === 500 ? 'internal server error' : (err as Error).message });
  });

  const port = Number(process.env['PORT'] ?? 3000);
  const server = app.listen(port, () => {
    console.log(`[server] nasłuchuje na porcie ${port}`);
  });

  // Batches can take anywhere from minutes to ~24h to resolve (Anthropic
  // Batches API), and the server keeps running the whole time — unlike the
  // CLI, which only checks on startup/`/batches`, there's no "next command"
  // to hang a check off of. Skipped while a turn is running (see the
  // GET /api/batches handler above for why).
  const batchInterval = setInterval(() => {
    if (turnState.status === 'running') return;
    resolvePendingBatches().catch(err => {
      console.error('[batch] okresowe sprawdzanie nie powiodło się:', (err as Error).message);
    });
  }, BATCH_CHECK_INTERVAL_MS);
  batchInterval.unref(); // don't let this timer alone keep the process alive

  // Docker sends SIGTERM on `docker stop`/a redeploy — without handling it,
  // Node kills every in-flight request immediately, which for a running
  // turn means losing whatever tool call or approval it was in the middle
  // of. This gives it a clean chance to finish first.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.log(`[server] otrzymano ${signal}, zamykam...`);
      clearInterval(batchInterval);
      server.close(async () => {
        await Promise.all(connections.map(c => c.close()));
        process.exit(0);
      });
      setTimeout(() => {
        console.error('[server] zamknięcie trwało zbyt długo, wymuszam wyjście');
        process.exit(1);
      }, 10_000).unref();
    });
  }
}

main().catch(err => {
  console.error('[server] fatal error:', err);
  process.exit(1);
});

// Without these, an error thrown outside Express's own request handling
// (e.g. deep in an MCP connection's background stream handling) crashes the
// process with whatever Node prints by default — on a headless Pi, with
// `restart: unless-stopped` bringing it straight back up, that can mean a
// silent crash-loop with nothing useful in `docker logs` to say why.
process.on('unhandledRejection', reason => {
  console.error('[server] unhandled promise rejection:', reason);
});
process.on('uncaughtException', err => {
  console.error('[server] uncaught exception:', err);
  process.exit(1); // Node's own guidance: state is untrustworthy after this — let restart:unless-stopped bring up a clean process rather than keep running one.
});
