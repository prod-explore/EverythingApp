import type Database from 'better-sqlite3';
import { createGazetaItem, type BatchJob, type GazetaItem } from './db.js';
import type { AnthropicLike } from './anthropic-loop.js';
import { cacheableSystem } from './anthropic-loop.js';

export type { GazetaItem };

/**
 * Virtual tool injected into every conversation's tool list.
 * When the model calls this, the server handles it internally by creating
 * a gazeta item — no MCP server needed.
 */
export const REQUEST_HUMAN_INPUT_TOOL = {
  name: 'request_human_input',
  description:
    "Ask the user a question as a form. It appears both in this chat and in the Gazeta inbox; the user answers once. " +
    "By default you wait for the answer (wait=true). With wait=false you continue immediately and the answer arrives " +
    "later as a message. Set urgent=true ONLY when the matter is genuinely time-critical — it pins the item and alerts the user.",
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Short title for the request (max 80 chars)' },
      description: {
        type: 'string',
        description: 'Detailed description with context. Markdown supported. Include: why you need this, what you\'ll do with the answer.',
      },
      choices: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional predefined choices the user can pick from. Leave empty for free-form text input.',
      },
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Machine key for this field, used in the returned response object.' },
            label: { type: 'string', description: 'Human-readable label shown above the input.' },
            type: { type: 'string', enum: ['text', 'number', 'select'], description: 'Defaults to text.' },
            options: { type: 'array', items: { type: 'string' }, description: 'Required when type is select.' },
          },
          required: ['name', 'label'],
        },
        description:
          'Optional multi-field form: ask for several labelled values at once (e.g. name + reason). ' +
          'Takes priority over choices when both are present. Leave empty for a single free-form text input.',
      },
      timeout_seconds: {
        type: 'number',
        description: 'Optional: seconds to wait before timing out. Default: wait indefinitely.',
      },
      wait: { type: 'boolean', description: 'true (default): block until answered. false: continue; the answer comes later as a message.' },
      urgent: { type: 'boolean', description: 'Only for genuinely time-critical questions. Default false.' },
    },
    required: ['title', 'description'],
  },
} as const;

/** Agent → user report in the Gazeta inbox (markdown, optional pinned workspace files). */
export const POST_REPORT_TOOL = {
  name: 'post_report',
  description:
    "Post a report to the user's Gazeta inbox" +
    ' (status update, findings, finished work). Markdown body. ' +
    'Optionally pin workspace files (paths under /workspace): a snapshot is stored with the report so it does not change when the file is edited later. ' +
    'Set urgent=true only for genuinely time-critical reports. Does not wait for a reply.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Short title (max 80 chars).' },
      body: { type: 'string', description: 'Markdown report.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Optional workspace file paths to pin (max 5).' },
      urgent: { type: 'boolean' },
    },
    required: ['title', 'body'],
  },
} as const;

/** Who asked and in which context — stored with every Gazeta item. */
export interface GazetaOrigin {
  projectId?: string | null;
  runId?: string | null;
  agent?: string | null;
}

export interface GazetaField {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'select';
  options?: string[];
}

/**
 * Called by server.ts when the model invokes 'request_human_input'.
 * Creates a gazeta item and returns a confirmation message to the model.
 */
export function handleRequestHumanInput(
  db: Database.Database,
  conversationId: string,
  args: { title: string; description: string; choices?: string[]; fields?: GazetaField[]; timeout_seconds?: number; urgent?: boolean },
  origin: GazetaOrigin = {},
): { itemId: string; message: string } {
  const inputSchema = args.fields?.length
    ? { type: 'fields', fields: args.fields }
    : args.choices?.length
      ? { type: 'choice', choices: args.choices }
      : { type: 'text' };

  const itemId = createGazetaItem(db, {
    type: 'agent_question',
    conversationId,
    title: args.title.slice(0, 200),
    description: args.description,
    inputSchema,
    urgent: args.urgent === true,
    ...origin,
  });

  return {
    itemId,
    message: "Your question has been queued in the user's Gazeta inbox. The agent will wait for your response before continuing.",
  };
}

/**
 * Called when a batch job resolves — creates a gazeta item so the user
 * can review the result and optionally continue the conversation.
 */
export function createBatchResultItem(db: Database.Database, job: BatchJob): string {
  return createGazetaItem(db, {
    type: 'batch_result',
    conversationId: job.conversationId,
    title: `Batch result: ${job.preview}`,
    description: job.resultText ?? '*(no response text)*',
  });
}

/**
 * Generates a daily digest of all pending gazeta items and new conversation
 * activity, submitted as a batch job for cost efficiency.
 * Returns the gazeta item ID for the summary.
 */
export async function generateDailySummary(
  db: Database.Database,
  anthropic: AnthropicLike,
  model: string,
): Promise<string> {
  const systemPrompt = 'You are a concise daily briefing assistant. Summarize the provided items in plain markdown. Be brief.';

  const { listGazetaItems } = await import('./db.js');
  const pending = listGazetaItems(db, 'pending');

  if (pending.length === 0) {
    return createGazetaItem(db, {
      type: 'daily_summary',
      title: 'Daily Digest',
      description: 'No pending items — all caught up!',
    });
  }

  const itemsText = pending
    .map((item, i) => `${i + 1}. [${item.type}] ${item.title}\n${item.description ?? ''}`)
    .join('\n\n');

  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system: cacheableSystem(systemPrompt),
    messages: [{ role: 'user', content: `Summarize these ${pending.length} pending items:\n\n${itemsText}` }],
  });

  const summaryText = (response.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n');

  return createGazetaItem(db, {
    type: 'daily_summary',
    title: `Daily Digest — ${pending.length} pending items`,
    description: summaryText,
  });
}

// ─── Blocking mode: agent waits for human response ───────────────────────────

/**
 * In-process registry of pending human-input promises.
 * Key = gazeta item ID, Value = { resolve, timer? }
 * When /api/gazeta/:id/respond is called, the server looks up this map
 * and resolves the matching promise, unblocking the agent turn.
 */
const pendingHumanInputs = new Map<
  string,
  { resolve: (response: unknown) => void; timer?: ReturnType<typeof setTimeout> }
>();

/**
 * Called by server.ts when the user responds to a gazeta item.
 * Resolves the blocking Promise in the agent turn (if any).
 * Returns true if a blocking turn was waiting, false if the item was async.
 */
export function resolveHumanInput(itemId: string, response: unknown): boolean {
  const pending = pendingHumanInputs.get(itemId);
  if (!pending) return false;
  if (pending.timer) clearTimeout(pending.timer);
  pendingHumanInputs.delete(itemId);
  pending.resolve(response);
  return true;
}

/**
 * Parks the current agent turn until the user responds via Gazeta.
 * Returns the user's response (parsed from the gazeta item).
 * If timeoutSeconds is set and expires, resolves with null (agent gets a timeout message).
 * If the AbortSignal fires (kill switch), rejects with an abort error.
 */
export function awaitHumanInput(
  itemId: string,
  signal?: AbortSignal,
  timeoutSeconds?: number,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Turn aborted by user (kill switch)'));
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      pendingHumanInputs.delete(itemId);
    };

    const onAbort = () => {
      cleanup();
      reject(new Error('Turn aborted by user (kill switch)'));
    };

    if (timeoutSeconds) {
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        pendingHumanInputs.delete(itemId);
        resolve(null); // null = timeout, server.ts will format the tool_result
      }, timeoutSeconds * 1000);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    pendingHumanInputs.set(itemId, {
      resolve: (response) => {
        signal?.removeEventListener('abort', onAbort);
        cleanup();
        resolve(response);
      },
      timer,
    });
  });
}
