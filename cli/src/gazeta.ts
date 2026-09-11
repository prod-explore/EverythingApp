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
    "Request input from the user that can be answered at their convenience via the Gazeta inbox. " +
    "Use when the question is not urgent and can wait for the user's next review session. " +
    "Do NOT use for urgent clarifications needed to complete the current task — ask inline instead.",
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
    },
    required: ['title', 'description'],
  },
} as const;

/**
 * Called by server.ts when the model invokes 'request_human_input'.
 * Creates a gazeta item and returns a confirmation message to the model.
 */
export function handleRequestHumanInput(
  db: Database.Database,
  conversationId: string,
  args: { title: string; description: string; choices?: string[] },
): string {
  const inputSchema = args.choices?.length
    ? { type: 'choice', choices: args.choices }
    : { type: 'text' };

  createGazetaItem(db, {
    type: 'agent_question',
    conversationId,
    title: args.title,
    description: args.description,
    inputSchema,
  });

  return "Your question has been queued in the user's Gazeta inbox. Continue with the rest of the task if possible, or let the user know you're waiting.";
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
