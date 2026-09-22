import express from 'express';
import helmet from 'helmet';
import { timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, type Config } from './config.js';
import { McpConnection } from './mcp-client.js';
import { ToolRegistry } from './tool-registry.js';
import { WebApprovalGate, type ApprovalScope } from './web-approval.js';
import { runTurn, type LlmClient } from './anthropic-loop.js';
import { submitBatch, checkBatch, type AnthropicBatchLike } from './batch.js';
import { UsageLedger, type UsageRange } from './usage-ledger.js';
import { ProviderRouter, ProviderNotConfiguredError } from './providers/router.js';
import { isProviderId } from './providers/registry.js';
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
  getAllMessagesFull,
  appendMessage,
  clearMessages,
  deleteMessagesFrom,
  deactivateMessagesFrom,
  getLastActiveMessage,
  findRegenerationAnchor,
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
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  getConversationSkills,
  attachSkill,
  detachSkill,
  setProviderWarnLimit,
  getProviderLimit,
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

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];
/** Base64 text length, not decoded byte size — ~8MB of base64 is ~6MB of actual image data. */
const MAX_ATTACHMENT_BASE64_LENGTH = 8_000_000;

/**
 * Builds the content to send to Anthropic (and to persist) from a composer
 * submission: plain text, or text + inline image attachments. Returns null
 * when there's nothing usable to send (Phase 1 — images only; other file
 * types are a follow-up, see the Full Build Roadmap in the vault).
 */
function buildMessageContent(rawContent: unknown, rawAttachments: unknown): Anthropic.MessageParam['content'] | null {
  const text = typeof rawContent === 'string' ? rawContent : '';
  const attachments = Array.isArray(rawAttachments) ? rawAttachments : [];

  const imageBlocks: Anthropic.ImageBlockParam[] = [];
  for (const a of attachments) {
    if (typeof a !== 'object' || a === null) continue;
    const mediaType = (a as Record<string, unknown>)['mediaType'];
    const data = (a as Record<string, unknown>)['data'];
    if (typeof mediaType !== 'string' || typeof data !== 'string') continue;
    if (!(SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mediaType)) continue;
    if (data.length > MAX_ATTACHMENT_BASE64_LENGTH) continue;
    imageBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaType as SupportedImageType, data },
    });
  }

  if (imageBlocks.length === 0) {
    return text.trim() ? text : null;
  }
  const blocks: Anthropic.ContentBlockParam[] = [...imageBlocks];
  if (text.trim()) blocks.push({ type: 'text', text });
  return blocks;
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

  // Keys come from the encrypted vault (Settings → Models); ANTHROPIC_API_KEY in
  // the environment is only a fallback. A missing key is not a startup error
  // any more — the turn that needs it fails with a message saying so.
  const router = new ProviderRouter({ db });
  if (!router.vault.enabled) {
    console.warn(`[vault] ${router.vault.disabledReason} — saving API keys from the UI is disabled until it is set.`);
  }

  const { app, stop } = await buildApp({ db, connections, router, authToken, config });

  // ─── Start server ─────────────────────────────────────────────────────────
  const port = Number(process.env['PORT'] ?? 3000);
  const server = app.listen(port, () => {
    console.log(`[server] listening on port ${port}`);
  });

  // ─── Graceful shutdown ────────────────────────────────────────────────────
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.log(`[server] received ${signal}, shutting down...`);
      stop();
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

/**
 * Assembles the Express app: tool registry, shared services (approval gate,
 * usage tracker, SSE manager), every /api route, static frontend serving,
 * and the background batch-check + SSE-keepalive intervals.
 *
 * Split out from main() so integration tests can build a real app against a
 * fake Anthropic client (LlmClient & AnthropicBatchLike) and an
 * in-memory db, with zero MCP connections and no live API key. main() still
 * owns app.listen() and process-level concerns (real MCP connect(), graceful
 * shutdown, SIGTERM/SIGINT) — a test can listen on an ephemeral port itself,
 * or hit the returned app directly.
 */
export interface BuildAppOptions {
  db: ReturnType<typeof openDb>;
  connections: McpConnection[];
  /** Provider resolution + key vault. Omit in tests to get a router whose Anthropic client is `anthropic`. */
  router?: ProviderRouter;
  /** Test double for the Anthropic client — only used when `router` is omitted. */
  anthropic?: LlmClient & AnthropicBatchLike;
  authToken: string;
  config: Pick<Config, 'model' | 'autoApproveTools' | 'webSearchEnabled'>;
}

export interface BuiltApp {
  app: express.Express;
  sse: SSEManager;
  /** Clears the background batch-check and SSE-keepalive intervals. Does not close the db or MCP connections — the caller owns those. */
  stop: () => void;
}

export async function buildApp(opts: BuildAppOptions): Promise<BuiltApp> {
  const { db, connections, authToken, config } = opts;
  const router = opts.router ?? new ProviderRouter({ db, anthropicOverride: opts.anthropic });

  const registry = new ToolRegistry(config.autoApproveTools);
  await registry.loadFrom(connections);
  console.log(`[tools] loaded ${registry.toAnthropicTools().length} tools from MCP`);

  // ─── Shared services ──────────────────────────────────────────────────────
  const approvalGate = new WebApprovalGate();
  const ledger = new UsageLedger(db);
  const sse = new SSEManager();

  // web_search is executed on Anthropic's side, so it only exists for Anthropic
  // models. request_human_input is an ordinary custom tool and works anywhere.
  const webSearchTool: Anthropic.ToolUnion = { type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: 5 };
  const humanInputTool = REQUEST_HUMAN_INPUT_TOOL as unknown as Anthropic.ToolUnion;

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
        const anthropicClient = router.anthropic();
        if (!anthropicClient) continue; // key removed since submission — leave the job pending rather than dropping it
        const resolution = await checkBatch(anthropicClient, {
          batchId: job.id,
          customId: job.customId,
          submittedAt: job.submittedAt,
          preview: job.preview,
        });
        if (!resolution) continue;
        resolveBatchJob(db, job.id, resolution.status, resolution.text);
        if (resolution.usage) {
          ledger.record({
            conversationId: job.conversationId,
            provider: 'anthropic',
            model: resolution.model ?? getSetting(db, 'default_model') ?? config.model,
            usage: resolution.usage,
            batch: true,
          });
        }
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
  // The SSE stream route is registered ABOVE this middleware with its own
  // auth check (see below) — EventSource, the browser API SSE uses, cannot
  // set custom headers, so that one route also has to accept the token as a
  // query param. Every other /api route only ever accepts the header.
  app.get('/api/conversations/:id/stream', (req, res) => {
    const queryToken = typeof req.query['token'] === 'string' ? req.query['token'] : undefined;
    const authorized =
      isValidAuthHeader(req.headers.authorization, authToken) ||
      (queryToken !== undefined && isValidAuthHeader(`Bearer ${queryToken}`, authToken));
    if (!authorized) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const conv = getConversation(db, req.params.id);
    if (!conv) { res.status(404).json({ error: 'conversation not found' }); return; }
    sse.addClient(req.params.id, res);
  });

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

  // ─── Turn execution (shared by /message, /edit, /regenerate, /retry) ──────
  /**
   * Runs one live turn to completion and persists everything it produces,
   * chained via parent_id off `userMessageId` (the user-facing message the
   * caller has *already* stored — this function never stores that one
   * itself, only what comes after it). Every caller below differs only in
   * how it arrives at historyBeforeTurn/content/userMessageId, not in how
   * the turn itself runs, hence the extraction.
   */
  function kickoffLiveTurn(
    convId: string,
    conv: NonNullable<ReturnType<typeof getConversation>>,
    historyBeforeTurn: Anthropic.MessageParam[],
    content: Anthropic.MessageParam['content'],
    userMessageId: number,
  ): number {
    const counter = (turnCounters.get(convId) ?? 0) + 1;
    turnCounters.set(convId, counter);
    const turnId = counter;
    const controller = new AbortController();
    abortControllers.set(convId, controller);
    turnStates.set(convId, { id: turnId, status: 'running' });
    sse.emit(convId, 'turn:start', { turnId });

    void (async () => {
      const effectiveModel = conv.model || getSetting(db, 'default_model') || config.model;
      // `||` not `??`: an empty-string setting (e.g. global_system_prompt
      // saved as "" from the Settings UI) must fall through to the default
      // too — `??` only catches null/undefined, and Anthropic's API rejects
      // a system text block with cache_control on empty text.
      let effectiveSystem = conv.systemPrompt || getSetting(db, 'global_system_prompt') || DEFAULT_SYSTEM_PROMPT;

      // Inject prompts from Skills attached to this conversation (Phase 2).
      // Each non-empty skill prompt is appended after a separator so the model
      // can distinguish skill instructions from the base system prompt.
      const attachedSkills = getConversationSkills(db, convId);
      const skillPrompts = attachedSkills.map(s => s.prompt).filter(Boolean);
      if (skillPrompts.length > 0) {
        effectiveSystem += '\n\n---\n\n' + skillPrompts.join('\n\n---\n\n');
      }

      // Auto-approve tools declared by attached skills for this chat
      attachedSkills.forEach(skill => {
        skill.allowedTools.forEach(tool => {
          approvalGate.grantChatScope(convId, tool);
        });
      });

      try {
        // Inside the try on purpose: a missing/undecryptable key must surface as an
        // ordinary turn:error the UI already knows how to show, not a crash.
        const { provider, info, client } = router.clientFor(effectiveModel);
        const serverTools = info.supportsWebSearch && config.webSearchEnabled ? [webSearchTool, humanInputTool] : [humanInputTool];

        const updatedHistory = await runTurn(
          {
            anthropic: client,
            model: effectiveModel,
            maxTokens: Math.max(4096, info.minOutputTokens ?? 0),
            tools: registry,
            systemPrompt: effectiveSystem,
            serverTools,
            signal: controller.signal,
            conversationId: convId,
            confirm: async (label, args) => {
              const approved = await approvalGate.confirm(convId, label, args);
              sse.emit(convId, 'approval:resolved', { toolLabel: label, approved });
              return approved;
            },
            onAssistantText: text => sse.emit(convId, 'turn:text', { text }),
            onToolStart: label => sse.emit(convId, 'turn:tool_use', { label }),
            onToolResult: (toolName, fullOutput, truncatedOutput, isError) => {
              sse.emit(convId, 'turn:tool_result', { toolName, truncatedOutput, isError, wasTruncated: fullOutput !== truncatedOutput });
            },
            onUsage: usage => {
              const { warning } = ledger.record({ conversationId: convId, provider, model: effectiveModel, usage });
              if (warning) sse.emitAll('usage:warning', warning);
            },
          },
          historyBeforeTurn,
          content,
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

        // Persist everything the turn produced AFTER the user message the
        // caller already stored, chaining each new row's parent_id off the
        // previous one so the whole turn (including tool-loop plumbing)
        // hangs off userMessageId as one branch.
        const newMessages = updatedHistory.slice(historyBeforeTurn.length + 1);
        let previousId = userMessageId;
        for (const msg of newMessages) {
          previousId = appendMessage(db, convId, msg.role, msg.content, previousId);
        }

        // Auto-title after first exchange
        const conv2 = getConversation(db, convId);
        if (conv2 && conv2.title === 'New conversation') {
          const titleSource = typeof content === 'string' ? content : '(attachment)';
          updateConversation(db, convId, { title: titleSource.slice(0, 60) });
        }

        turnStates.set(convId, { id: turnId, status: 'done' });
        sse.emit(convId, 'turn:done', { turnId, usage: ledger.headline() });
      } catch (err) {
        const error = router.redact((err as Error).message);
        const aborted = error.includes('kill switch');
        // Deliberately NOT rolling back the user's message here (it was
        // already persisted before this async block even started) —
        // whatever failed, the user did type it, and silently discarding
        // it on any error (a transient network blip, a tool failure,
        // anything) is a worse outcome than leaving it visible with no
        // assistant reply. The turn:error/aborted event below is what
        // tells the UI this turn didn't complete. (See retry, below, for
        // how this state gets resolved.)
        turnStates.set(convId, { id: turnId, status: aborted ? 'aborted' : 'error', error });
        sse.emit(convId, aborted ? 'turn:aborted' : 'turn:error', { turnId, error });
      } finally {
        abortControllers.delete(convId);
      }
    })();

    return turnId;
  }

  /**
   * Shared by /regenerate and /retry: finds the nearest user message at or
   * before `fromId` (null = search from the end), retires it and everything
   * after, and re-sends its exact original content as a fresh branch.
   */
  function regenerateFrom(
    convId: string,
    conv: NonNullable<ReturnType<typeof getConversation>>,
    fromId: number | null,
  ): { ok: true; turnId: number } | { ok: false; status: number; error: string } {
    const anchor = findRegenerationAnchor(db, convId, fromId);
    if (!anchor) return { ok: false, status: 404, error: 'no prior user message found to regenerate from' };

    deactivateMessagesFrom(db, convId, anchor.id);
    const historyBeforeTurn = getMessages(db, convId) as Anthropic.MessageParam[];
    const resendContent = anchor.content as Anthropic.MessageParam['content'];
    const userMessageId = appendMessage(db, convId, 'user', resendContent, anchor.parentId);
    const turnId = kickoffLiveTurn(convId, conv, historyBeforeTurn, resendContent, userMessageId);
    return { ok: true, turnId };
  }

  // ─── Send message ─────────────────────────────────────────────────────────
  app.post('/api/conversations/:id/message', (req, res) => {
    const convId = req.params.id;
    const { content: rawContent, text, batch, attachments } = req.body ?? {};
    const content = buildMessageContent(rawContent ?? text, attachments);

    if (content === null) {
      res.status(400).json({ error: 'expected { content: string, attachments?: Array<{ mediaType, data }> }' });
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
      if (typeof content !== 'string') {
        res.status(400).json({ error: 'attachments are not supported in batch mode yet' });
        return;
      }
      const history = getMessages(db, convId);
      const effectiveModel = conv.model || getSetting(db, 'default_model') || config.model;
      const effectiveSystem = conv.systemPrompt || getSetting(db, 'global_system_prompt') || DEFAULT_SYSTEM_PROMPT;

      let batchClient: ReturnType<typeof router.anthropic>;
      try {
        const resolved = router.clientFor(effectiveModel);
        if (!resolved.info.supportsBatch) {
          res.status(400).json({ error: `Batch mode is only available for Anthropic models (this conversation uses ${effectiveModel}).` });
          return;
        }
        batchClient = router.anthropic();
      } catch (err) {
        res.status(err instanceof ProviderNotConfiguredError ? 400 : 500).json({ error: (err as Error).message });
        return;
      }
      if (!batchClient) { res.status(400).json({ error: 'No Anthropic API key configured — add one in Settings → Models.' }); return; }
      const client = batchClient;
      void (async () => {
        try {
          const entry = await submitBatch(client, effectiveModel, effectiveSystem, history as Anthropic.MessageParam[], content);
          appendMessage(db, convId, 'user', content);
          createBatchJob(db, { id: entry.batchId, conversationId: convId, customId: entry.customId, userText: content, preview: entry.preview });
          res.json({ ok: true, batchId: entry.batchId });
        } catch (err) {
          res.status(500).json({ error: router.redact((err as Error).message) });
        }
      })();
      return;
    }

    // Live turn — runs detached from the HTTP request. historyBeforeTurn is
    // read BEFORE the optimistic append below, so it never includes the
    // message we're about to store.
    const historyBeforeTurn = getMessages(db, convId) as Anthropic.MessageParam[];
    const userMessageId = appendMessage(db, convId, 'user', content);
    const turnId = kickoffLiveTurn(convId, conv, historyBeforeTurn, content, userMessageId);
    res.json({ ok: true, turnId });
  });

  // ─── Edit / regenerate / retry ─────────────────────────────────────────────
  // Together these are Phase 1's message-branching feature: editing a user
  // message or regenerating/retrying an assistant reply never destroys the
  // old branch (see db.ts's is_active) — it retires it and starts a new one.
  // There's no UI to browse retired branches yet (see the Full Build
  // Roadmap in the vault, Phase 1 follow-up), but the data is there for it.
  app.post('/api/conversations/:id/edit', (req, res) => {
    const convId = req.params.id;
    const conv = getConversation(db, convId);
    if (!conv) { res.status(404).json({ error: 'conversation not found' }); return; }
    if (getTurnState(convId).status === 'running') {
      res.status(409).json({ error: 'a turn is already running in this conversation' });
      return;
    }
    const { parentId, content } = req.body ?? {};
    if (typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'expected { content: string, parentId: number | null }' });
      return;
    }
    const afterId = parentId === null || parentId === undefined ? null : Number(parentId);
    if (afterId !== null && !Number.isInteger(afterId)) {
      res.status(400).json({ error: 'parentId must be an integer or null' });
      return;
    }
    const activeBefore = getMessages(db, convId);
    if (afterId !== null && !activeBefore.some(m => m.id === afterId)) {
      res.status(400).json({ error: 'parentId does not refer to a message in this conversation' });
      return;
    }

    deactivateMessagesFrom(db, convId, afterId !== null ? afterId + 1 : 0);
    const historyBeforeTurn = getMessages(db, convId) as Anthropic.MessageParam[];
    const userMessageId = appendMessage(db, convId, 'user', content, afterId);
    const turnId = kickoffLiveTurn(convId, conv, historyBeforeTurn, content, userMessageId);
    res.json({ ok: true, turnId });
  });

  app.post('/api/conversations/:id/regenerate', (req, res) => {
    const convId = req.params.id;
    const conv = getConversation(db, convId);
    if (!conv) { res.status(404).json({ error: 'conversation not found' }); return; }
    if (getTurnState(convId).status === 'running') {
      res.status(409).json({ error: 'a turn is already running in this conversation' });
      return;
    }
    const { parentId } = req.body ?? {};
    const fromId = parentId === null || parentId === undefined ? null : Number(parentId);
    if (fromId !== null && !Number.isInteger(fromId)) {
      res.status(400).json({ error: 'parentId must be an integer or null' });
      return;
    }
    const result = regenerateFrom(convId, conv, fromId);
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.json({ ok: true, turnId: result.turnId });
  });

  app.post('/api/conversations/:id/retry', (req, res) => {
    const convId = req.params.id;
    const conv = getConversation(db, convId);
    if (!conv) { res.status(404).json({ error: 'conversation not found' }); return; }
    if (getTurnState(convId).status === 'running') {
      res.status(409).json({ error: 'a turn is already running in this conversation' });
      return;
    }
    const last = getLastActiveMessage(db, convId);
    if (!last) { res.status(404).json({ error: 'conversation has no messages yet' }); return; }
    const result = regenerateFrom(convId, conv, last.id);
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.json({ ok: true, turnId: result.turnId });
  });

  // Hard delete of a single message and everything after it — distinct from
  // DELETE /messages above, which wipes the whole conversation. An explicit
  // user delete is a real removal, unlike edit/regenerate's soft retire.
  app.delete('/api/conversations/:id/messages/:messageId', (req, res) => {
    const convId = req.params.id;
    const conv = getConversation(db, convId);
    if (!conv) { res.status(404).json({ error: 'conversation not found' }); return; }
    if (getTurnState(convId).status === 'running') {
      res.status(409).json({ error: 'turn is running — kill it first' });
      return;
    }
    const messageId = Number(req.params.messageId);
    if (!Number.isInteger(messageId)) { res.status(400).json({ error: 'invalid message id' }); return; }
    const ok = deleteMessagesFrom(db, convId, messageId);
    if (!ok) { res.status(404).json({ error: 'message not found' }); return; }
    res.json({ ok: true });
  });

  // Full message history including retired branches — not used by the chat
  // UI yet (which only ever renders the active branch via GET .../messages),
  // but exposed now for the branch-history UI planned as a Phase 1 follow-up.
  app.get('/api/conversations/:id/messages/full', (req, res) => {
    const conv = getConversation(db, req.params.id);
    if (!conv) { res.status(404).json({ error: 'conversation not found' }); return; }
    res.json({ messages: getAllMessagesFull(db, req.params.id) });
  });

  // ─── Approvals ────────────────────────────────────────────────────────────
  app.get('/api/pending-approvals', (_req, res) => {
    res.json({ pending: approvalGate.listPending() });
  });

  app.post('/api/approve', (req, res) => {
    const { id, approved, scope } = req.body ?? {};
    if (typeof id !== 'string' || typeof approved !== 'boolean') {
      res.status(400).json({ error: 'expected { id: string, approved: boolean, scope?: "once"|"chat"|"always" }' });
      return;
    }
    // Validate scope, fall back to 'once' for anything unrecognised or missing.
    const validScopes: ApprovalScope[] = ['once', 'chat', 'always'];
    const resolvedScope: ApprovalScope = validScopes.includes(scope) ? scope as ApprovalScope : 'once';
    const ok = approvalGate.resolve(id, approved, resolvedScope);
    if (!ok) { res.status(404).json({ error: 'no such pending approval' }); return; }
    res.json({ ok: true });
  });

  // ─── Skills ───────────────────────────────────────────────────────────────
  app.get('/api/skills', (_req, res) => {
    res.json({ skills: listSkills(db) });
  });

  app.post('/api/skills', (req, res) => {
    const { name, description, prompt, allowedTools } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'expected { name: string, description?, prompt?, allowedTools?: string[] }' });
      return;
    }
    const skill = createSkill(db, { name: name.trim(), description, prompt, allowedTools });
    res.status(201).json({ skill });
  });

  app.patch('/api/skills/:id', (req, res) => {
    const { name, description, prompt, allowedTools } = req.body ?? {};
    const ok = updateSkill(db, req.params.id, { name, description, prompt, allowedTools });
    if (!ok) { res.status(404).json({ error: 'skill not found or no fields to update' }); return; }
    res.json({ ok: true, skill: getSkill(db, req.params.id) });
  });

  app.delete('/api/skills/:id', (req, res) => {
    const ok = deleteSkill(db, req.params.id);
    if (!ok) { res.status(404).json({ error: 'skill not found' }); return; }
    res.json({ ok: true });
  });

  app.get('/api/conversations/:id/skills', (req, res) => {
    const conv = getConversation(db, req.params.id);
    if (!conv) { res.status(404).json({ error: 'conversation not found' }); return; }
    res.json({ skills: getConversationSkills(db, req.params.id) });
  });

  app.post('/api/conversations/:id/skills/:skillId', (req, res) => {
    const conv = getConversation(db, req.params.id);
    if (!conv) { res.status(404).json({ error: 'conversation not found' }); return; }
    if (!getSkill(db, req.params.skillId)) { res.status(404).json({ error: 'skill not found' }); return; }
    attachSkill(db, req.params.id, req.params.skillId);
    res.status(201).json({ ok: true });
  });

  app.delete('/api/conversations/:id/skills/:skillId', (req, res) => {
    const ok = detachSkill(db, req.params.id, req.params.skillId);
    if (!ok) { res.status(404).json({ error: 'skill not attached to this conversation' }); return; }
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
    res.json({ summary: ledger.headline() });
  });

  const USAGE_RANGES: readonly UsageRange[] = ['today', '7d', '30d', 'month', 'all'];
  app.get('/api/usage/report', (req, res) => {
    const range = (typeof req.query['range'] === 'string' ? req.query['range'] : '30d') as UsageRange;
    if (!USAGE_RANGES.includes(range)) {
      res.status(400).json({ error: `range must be one of ${USAGE_RANGES.join(', ')}` });
      return;
    }
    // tzOffset: minutes east of UTC (Poland in summer = 120), so "today" and daily buckets follow the viewer's clock.
    const tzOffset = Number(req.query['tzOffset'] ?? 0);
    res.json(ledger.report(range, tzOffset));
  });

  // ─── Providers & key vault ────────────────────────────────────────────────
  // Keys are write-only over this API: they go in via PUT and never come back
  // out — only presence, source and the last four characters are ever returned.
  function providerIdOr404(raw: string, res: express.Response): ReturnType<typeof asProviderId> {
    const id = asProviderId(raw);
    if (!id) res.status(404).json({ error: `unknown provider '${raw}'` });
    return id;
  }
  function asProviderId(raw: string) {
    return isProviderId(raw) ? raw : null;
  }

  app.get('/api/providers', (_req, res) => {
    res.json({
      vaultEnabled: router.vault.enabled,
      vaultDisabledReason: router.vault.disabledReason,
      providers: router.status().map(p => ({ ...p, warnUsdMonthly: getProviderLimit(db, p.id).warnUsdMonthly })),
    });
  });

  app.get('/api/models', (_req, res) => {
    res.json({ models: router.models().filter(m => !m.hidden).map(({ pricing, ...m }) => ({ ...m, pricingKnown: pricing !== null })) });
  });

  app.put('/api/providers/:id/key', async (req, res) => {
    const id = providerIdOr404(req.params.id, res);
    if (!id) return;
    const key = req.body?.key;
    if (typeof key !== 'string' || key.trim().length < 8 || key.length > 512 || /\s/.test(key.trim())) {
      res.status(400).json({ error: 'expected { key: string } — a single token with no whitespace' });
      return;
    }
    if (!router.vault.enabled) {
      res.status(503).json({ error: router.vault.disabledReason });
      return;
    }
    router.saveKey(id, key.trim());
    // Verify right away so a typo is caught now, not on the next chat turn. The key stays saved either way —
    // a provider outage shouldn't make the user lose what they just typed.
    const test = req.body?.verify === false ? null : await router.test(id);
    res.json({ ok: true, verified: test ? test.ok : null, verifyError: test && !test.ok ? test.error : null });
  });

  app.delete('/api/providers/:id/key', (req, res) => {
    const id = providerIdOr404(req.params.id, res);
    if (!id) return;
    res.json({ ok: router.removeKey(id) });
  });

  app.post('/api/providers/:id/test', async (req, res) => {
    const id = providerIdOr404(req.params.id, res);
    if (!id) return;
    res.json(await router.test(id));
  });

  app.put('/api/providers/:id/limits', (req, res) => {
    const id = providerIdOr404(req.params.id, res);
    if (!id) return;
    const v = req.body?.warnUsdMonthly;
    if (v !== null && !(typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1_000_000)) {
      res.status(400).json({ error: 'expected { warnUsdMonthly: number > 0 | null }' });
      return;
    }
    setProviderWarnLimit(db, id, v);
    res.json({ ok: true });
  });

  // ─── Turn status (legacy polling compat) ──────────────────────────────────
  app.get('/api/conversations/:id/status', (req, res) => {
    const state = getTurnState(req.params.id);
    res.json({ ...state, usage: ledger.headline() });
  });

  // ─── Static frontend ─────────────────────────────────────────────────────
  const webDistPath = path.join(__dirname, '..', '..', 'web', 'dist');
  app.use(express.static(webDistPath));
  // Express 5 (path-to-regexp v7+) rejects a bare '*' — it's ambiguous
  // now. This app is a single-page app, so the SPA fallback needs a
  // pattern that matches literally everything not already handled above
  // (every /api/* route, static assets from webDistPath); '/*splat' is
  // the current syntax for that.
  app.get('/*splat', (_req, res) => {
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

  // ─── Background jobs ──────────────────────────────────────────────────────
  const keepaliveInterval = sse.startKeepalive();

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

  function stop(): void {
    clearInterval(batchInterval);
    clearInterval(keepaliveInterval);
  }

  return { app, sse, stop };
}

// Only actually boot the server (and install process-level handlers) when
// this file is run directly (`node dist/server.js`) — not when it's
// imported purely for `buildApp()`, e.g. by integration tests, which must
// not have the side effect of reading real env vars, opening the real db,
// or listening on a real port.
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
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
}
