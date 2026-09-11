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
import { submitBatch, checkBatch } from './batch.js';
import { UsageTracker } from './usage-tracker.js';
import { SSEManager } from './sse.js';
import { REQUEST_HUMAN_INPUT_TOOL, handleRequestHumanInput, createBatchResultItem } from './gazeta.js';
import {
  openDb,
  runMigrations,
  createConversation,
  listConversations,
  getConversation,
  updateConversation,
  deleteConversation,
  getMessages,
  appendMessage,
  clearMessages,
  getSetting,
  setSetting,
  getAllSettings,
  listGazetaItems,
  respondToGazetaItem,
  dismissGazetaItem,
  createBatchJob,
  listBatchJobs,
  resolveBatchJob,
  getPendingBatchJobs,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_SYSTEM_PROMPT = `You are Mikołaj's personal AI assistant in EverythingApp — his self-hosted BYOK AI system accessed via web browser (phone or desktop). You have access to tools exposed by connected MCP servers. Every tool call with a side effect goes through the Approval Gate on the page — if rejected, inform the user and suggest an alternative instead of retrying the same call in a loop. When you need non-urgent input from the user, use the request_human_input tool to queue it in their Gazeta inbox. Be concise and direct.`;

const BATCH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

function isValidAuthHeader(header: string | undefined, expectedToken: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${expectedToken}`);
  const actual = Buffer.from(header);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const authToken = process.env['SERVER_AUTH_TOKEN'];
  if (!authToken) throw new Error('Missing required environment variable: SERVER_AUTH_TOKEN');

  // ─── Database ─────────────────────────────────────────────────────────────
  const db = openDb();
  runMigrations(db);

  // ─── MCP connections ──────────────────────────────────────────────────────
  const connections = config.mcpServers.map(cfg => new McpConnection(cfg));
  for (const conn of connections) {
    try {
      await conn.connect();
      console.log(`[mcp] connected to '${conn.name}'`);
    } catch (err) {
      console.error(`[mcp] failed to connect to '${conn.name}':`, (err as Error).message);
    }
  }

  const registry = new ToolRegistry(config.autoApproveTools);
  await registry.loadFrom(connections);
  console.log(`[tools] loaded ${registry.toAnthropicTools().length} tools from MCP`);

  // ─── Shared services ──────────────────────────────────────────────────────
  const approvalGate = new WebApprovalGate();
  const usageTracker = new UsageTracker();
  const sse = new SSEManager();
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

  const serverTools: Anthropic.ToolUnion[] = [
    ...(config.webSearchEnabled
      ? [{ type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: 5 }]
      : []),
    REQUEST_HUMAN_INPUT_TOOL as unknown as Anthropic.ToolUnion,
  ];

  // ─── Per-conversation turn state ──────────────────────────────────────────
  type TurnStatus = 'idle' | 'running' | 'done' | 'error' | 'aborted';
  interface TurnState { id: number; status: TurnStatus; error?: string }
  const turnCounters = new Map<string, number>();
  const turnStates = new Map<string, TurnState>();
  const abortControllers = new Map<string, AbortController>();

  function getTurnState(convId: string): TurnState {
    return turnStates.get(convId) ?? { id: 0, status: 'idle' };
  }

  // ─── Background batch checker ─────────────────────────────────────────────
  async function resolvePendingBatches(skipConvId?: string): Promise<void> {
    const pending = getPendingBatchJobs(db);
    if (pending.length === 0) return;
    for (const job of pending) {
      if (skipConvId && job.conversationId === skipConvId) continue;
      try {
        const resolution = await checkBatch(anthropic, {
          batchId: job.id,
          customId: job.customId,
          submittedAt: job.submittedAt,
          preview: job.preview,
        });
        if (!resolution) continue;
        resolveBatchJob(db, job.id, resolution.status, resolution.text);
        if (resolution.status === 'succeeded' && resolution.text) {
          appendMessage(db, job.conversationId, 'assistant', resolution.text);
          // Create a gazeta item so user sees the batch result
          createBatchResultItem(db, { ...job, resultText: resolution.text });
          sse.emit(job.conversationId, 'batch:resolved', { jobId: job.id, convId: job.conversationId });
          sse.emitAll('gazeta:new', { type: 'batch_result' });
        }
      } catch (err) {
        console.error(`[batch] error checking ${job.id}:`, (err as Error).message);
      }
    }
  }

  // ─── Express setup ────────────────────────────────────────────────────────
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Tailwind needs this
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      },
    },
  }));
  app.use(express.json({ limit: '10mb' }));

  // ─── Health (no auth) ─────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    const connectorStatus = connections.map(c => ({ name: c.name }));
    res.json({ status: 'ok', connectors: connectorStatus });
  });

  // ─── Auth middleware ──────────────────────────────────────────────────────
  app.use('/api', (req, res, next) => {
    if (!isValidAuthHeader(req.headers.authorization, authToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  // ─── Settings ─────────────────────────────────────────────────────────────
  app.get('/api/settings', (_req, res) => {
    res.json({ settings: getAllSettings(db) });
  });

  app.put('/api/settings', (req, res) => {
    const { key, value } = req.body ?? {};
    if (typeof key !== 'string' || typeof value !== 'string') {
      res.status(400).json({ error: 'expected { key: string, value: string }' });
      return;
    }
    setSetting(db, key, value);
    res.json({ ok: true });
  });

  // ─── Connectors ───────────────────────────────────────────────────────────
  app.get('/api/connectors', (_req, res) => {
    const data = connections.map(conn => {
      const tools = registry.toAnthropicTools().filter(t => t.name.startsWith(`${conn.name}__`));
      return {
        name: conn.name,
        connected: true, // if it's in the list, it connected at startup
        toolCount: tools.length,
        tools: tools.map(t => ({ name: t.name, description: t.description })),
      };
    });
    res.json({ connectors: data });
  });

  // ─── Conversations ────────────────────────────────────────────────────────
  app.get('/api/conversations', (_req, res) => {
    res.json({ conversations: listConversations(db) });
  });

  app.post('/api/conversations', (req, res) => {
    const { title, systemPrompt, model, sandboxEnabled } = req.body ?? {};
    const { id } = createConversation(db, { title, systemPrompt, model, sandboxEnabled });
    res.status(201).json({ id });
  });

  app.get('/api/conversations/:id', (req, res) => {
    const conv = getConversation(db, req.params.id);
    if (!conv) { res.status(404).json({ error: 'conversation not found' }); return; }
    res.json(conv);
  });

  app.patch('/api/conversations/:id', (req, res) => {
    const ok = updateConversation(db, req.params.id, req.body ?? {});
    if (!ok) { res.status(404).json({ error: 'conversation not found' }); return; }
    res.json({ ok: true });
  });

  app.delete('/api/conversations/:id', (req, res) => {
    const ok = deleteConversation(db, req.params.id);
    if (!ok) { res.status(404).json({ error: 'conversation not found' }); return; }
    res.json({ ok: true });
  });

  // ─── Messages ─────────────────────────────────────────────────────────────
  app.get('/api/conversations/:id/messages', (req, res) => {
    const conv = getConversation(db, req.params.id);
    if (!conv) { res.status(404).json({ error: 'conversation not found' }); return; }
    res.json({ messages: getMessages(db, req.params.id) });
  });

  app.delete('/api/conversations/:id/messages', (req, res) => {
    const conv = getConversation(db, req.params.id);
    if (!conv) { res.status(404).json({ error: 'conversation not found' }); return; }
    if (getTurnState(req.params.id).status === 'running') {
      res.status(409).json({ error: 'turn is running — kill it first' });
      return;
    }
    clearMessages(db, req.params.id);
    res.json({ ok: true });
  });

  // ─── SSE stream ───────────────────────────────────────────────────────────
  app.get('/api/conversations/:id/stream', (req, res) => {
    const conv = getConversation(db, req.params.id);
    if (!conv) { res.status(404).json({ error: 'conversation not found' }); return; }
    sse.addClient(req.params.id, res);
  });

  // ─── Kill switch ──────────────────────────────────────────────────────────
  app.post('/api/conversations/:id/kill', (req, res) => {
    const controller = abortControllers.get(req.params.id);
    if (!controller) {
      res.status(409).json({ error: 'no running turn for this conversation' });
      return;
    }
    controller.abort();
    res.json({ ok: true });
  });

  // ─── Send message ─────────────────────────────────────────────────────────
  app.post('/api/conversations/:id/message', (req, res) => {
    const convId = req.params.id;
    const { text, batch } = req.body ?? {};

    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'expected { text: string }' });
      return;
    }
    const conv = getConversation(db, convId);
    if (!conv) { res.status(404).json({ error: 'conversation not found' }); return; }
    if (getTurnState(convId).status === 'running') {
      res.status(409).json({ error: 'a turn is already running in this conversation' });
      return;
    }

    // Batch mode — submit to Anthropic Batch API instead
    if (batch) {
      const history = getMessages(db, convId);
      const effectiveModel = conv.model ?? getSetting(db, 'default_model') ?? config.model;
      const effectiveSystem = conv.systemPrompt ?? getSetting(db, 'global_system_prompt') ?? DEFAULT_SYSTEM_PROMPT;
      void (async () => {
        try {
          const entry = await submitBatch(anthropic, effectiveModel, effectiveSystem, history as Anthropic.MessageParam[], text);
          appendMessage(db, convId, 'user', text);
          createBatchJob(db, { id: entry.batchId, conversationId: convId, customId: entry.customId, userText: text, preview: entry.preview });
          res.json({ ok: true, batchId: entry.batchId });
        } catch (err) {
          res.status(500).json({ error: (err as Error).message });
        }
      })();
      return;
    }

    // Live turn — runs detached from the HTTP request
    const counter = (turnCounters.get(convId) ?? 0) + 1;
    turnCounters.set(convId, counter);
    const turnId = counter;
    const controller = new AbortController();
    abortControllers.set(convId, controller);

    // Optimistic: store user message immediately
    appendMessage(db, convId, 'user', text);
    turnStates.set(convId, { id: turnId, status: 'running' });
    res.json({ ok: true, turnId });

    sse.emit(convId, 'turn:start', { turnId });

    void (async () => {
      const history = getMessages(db, convId) as Anthropic.MessageParam[];
      // Remove the optimistically added user message — runTurn will rebuild it
      const historyBeforeTurn = history.slice(0, -1);
      const effectiveModel = conv.model ?? getSetting(db, 'default_model') ?? config.model;
      const effectiveSystem = conv.systemPrompt ?? getSetting(db, 'global_system_prompt') ?? DEFAULT_SYSTEM_PROMPT;

      try {
        const updatedHistory = await runTurn(
          {
            anthropic,
            model: effectiveModel,
            tools: registry,
            systemPrompt: effectiveSystem,
            serverTools,
            signal: controller.signal,
            confirm: async (label, args) => {
              const approved = await approvalGate.confirm(label, args);
              sse.emit(convId, 'approval:resolved', { toolLabel: label, approved });
              return approved;
            },
            onAssistantText: text => sse.emit(convId, 'turn:text', { text }),
            onToolStart: label => sse.emit(convId, 'turn:tool_use', { label }),
            onToolResult: (toolName, fullOutput, truncatedOutput, isError) => {
              sse.emit(convId, 'turn:tool_result', { toolName, truncatedOutput, isError, wasTruncated: fullOutput !== truncatedOutput });
            },
            onUsage: usage => usageTracker.record(usage),
          },
          historyBeforeTurn,
          text,
        );

        // Handle virtual tool calls (request_human_input) in the updated history
        for (const msg of updatedHistory) {
          if (msg.role !== 'assistant') continue;
          const blocks = Array.isArray(msg.content) ? msg.content : [];
          for (const block of blocks) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'tool_use' &&
              'name' in block &&
              block.name === 'request_human_input'
            ) {
              const input = (block as { input: { title: string; description: string; choices?: string[] } }).input;
              handleRequestHumanInput(db, convId, input);
              sse.emitAll('gazeta:new', { type: 'agent_question' });
            }
          }
        }

        // Persist final history (excluding the optimistic user message we already saved)
        // We already stored the user message — only store new messages from this turn
        const newMessages = updatedHistory.slice(historyBeforeTurn.length + 1); // skip the user message
        for (const msg of newMessages) {
          appendMessage(db, convId, msg.role, msg.content);
        }

        // Auto-title after first exchange
        const conv2 = getConversation(db, convId);
        if (conv2 && conv2.title === 'New conversation') {
          updateConversation(db, convId, { title: text.slice(0, 60) });
        }

        turnStates.set(convId, { id: turnId, status: 'done' });
        sse.emit(convId, 'turn:done', { turnId, usage: usageTracker.summary() });
      } catch (err) {
        const error = (err as Error).message;
        const aborted = error.includes('kill switch');
        // Roll back optimistic user message
        const msgs = getMessages(db, convId);
        if (msgs.length > 0 && msgs[msgs.length - 1].role === 'user') {
          clearMessages(db, convId);
          for (const m of msgs.slice(0, -1)) appendMessage(db, convId, m.role, m.content);
        }
        turnStates.set(convId, { id: turnId, status: aborted ? 'aborted' : 'error', error });
        sse.emit(convId, aborted ? 'turn:aborted' : 'turn:error', { turnId, error });
      } finally {
        abortControllers.delete(convId);
      }
    })();
  });

  // ─── Approvals ────────────────────────────────────────────────────────────
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
    if (!ok) { res.status(404).json({ error: 'no such pending approval' }); return; }
    res.json({ ok: true });
  });

  // ─── Gazeta ───────────────────────────────────────────────────────────────
  app.get('/api/gazeta', (req, res) => {
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
    res.json({ items: listGazetaItems(db, status) });
  });

  app.post('/api/gazeta/:id/respond', (req, res) => {
    const ok = respondToGazetaItem(db, req.params.id, req.body?.response ?? null);
    if (!ok) { res.status(404).json({ error: 'item not found' }); return; }
    res.json({ ok: true });
  });

  app.post('/api/gazeta/:id/dismiss', (req, res) => {
    const ok = dismissGazetaItem(db, req.params.id);
    if (!ok) { res.status(404).json({ error: 'item not found' }); return; }
    res.json({ ok: true });
  });

  // ─── Batch jobs ───────────────────────────────────────────────────────────
  app.get('/api/batches', (_req, res) => {
    res.json({ jobs: listBatchJobs(db) });
  });

  app.get('/api/conversations/:id/batches', (req, res) => {
    res.json({ jobs: listBatchJobs(db, { conversationId: req.params.id }) });
  });

  // ─── Usage ────────────────────────────────────────────────────────────────
  app.get('/api/usage', (_req, res) => {
    res.json({ summary: usageTracker.summary() });
  });

  // ─── Turn status (legacy polling compat) ──────────────────────────────────
  app.get('/api/conversations/:id/status', (req, res) => {
    const state = getTurnState(req.params.id);
    res.json({ ...state, usage: usageTracker.summary() });
  });

  // ─── Static frontend ─────────────────────────────────────────────────────
  const webDistPath = path.join(__dirname, '..', '..', 'web', 'dist');
  app.use(express.static(webDistPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(webDistPath, 'index.html'));
  });

  // ─── Global error handler ─────────────────────────────────────────────────
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[server] unhandled error:', err);
    if (res.headersSent) return;
    const statusCode =
      typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number'
        ? err.statusCode
        : 500;
    res.status(statusCode).json({ error: statusCode === 500 ? 'internal server error' : (err as Error).message });
  });

  // ─── Start server ─────────────────────────────────────────────────────────
  const port = Number(process.env['PORT'] ?? 3000);
  const server = app.listen(port, () => {
    console.log(`[server] listening on port ${port}`);
  });

  const keepaliveInterval = sse.startKeepalive();

  // ─── Background batch checking ────────────────────────────────────────────
  const batchInterval = setInterval(() => {
    const runningConvIds = [...turnStates.entries()]
      .filter(([, s]) => s.status === 'running')
      .map(([id]) => id);
    // Skip conversations with running turns to avoid concurrent history mutation
    for (const convId of runningConvIds) {
      resolvePendingBatches(convId).catch(err => {
        console.error('[batch] background check failed:', (err as Error).message);
      });
    }
  }, BATCH_CHECK_INTERVAL_MS);
  batchInterval.unref();

  // ─── Graceful shutdown ────────────────────────────────────────────────────
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.log(`[server] received ${signal}, shutting down...`);
      clearInterval(batchInterval);
      clearInterval(keepaliveInterval);
      server.close(async () => {
        await Promise.all(connections.map(c => c.close()));
        db.close();
        process.exit(0);
      });
      setTimeout(() => {
        console.error('[server] shutdown timeout, forcing exit');
        process.exit(1);
      }, 10_000).unref();
    });
  }
}

main().catch(err => {
  console.error('[server] fatal error:', err);
  process.exit(1);
});

process.on('unhandledRejection', reason => {
  console.error('[server] unhandled promise rejection:', reason);
});
process.on('uncaughtException', err => {
  console.error('[server] uncaught exception:', err);
  process.exit(1);
});
