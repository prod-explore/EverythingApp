import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { cacheableSystem } from './anthropic-loop.js';
import type { PendingBatch } from './batch-store.js';

/** Minimal slice of the Anthropic SDK's batches API — lets tests inject a fake. */
export interface AnthropicBatchLike {
  messages: {
    batches: {
      create(params: Anthropic.Messages.BatchCreateParams): Promise<Anthropic.Messages.MessageBatch>;
      retrieve(id: string): Promise<Anthropic.Messages.MessageBatch>;
      results(id: string): Promise<AsyncIterable<Anthropic.Messages.MessageBatchIndividualResponse>>;
    };
  };
}

export interface BatchResolution {
  entry: PendingBatch;
  status: 'succeeded' | 'errored' | 'canceled' | 'expired';
  /** Assistant's reply text, only set when status is 'succeeded'. */
  text?: string;
  errorDetail?: string;
}

/**
 * Submits the current turn as a batch job instead of a live call — §11.3 /
 * §8 of the Master Brief. Deliberately text-only: no tools. The Batch API has
 * no live round trip, so a tool_use the model asked for could never actually
 * get executed and approved before the batch "completes" — that combination
 * is explicitly out of scope (Master Brief §8: batch is for standalone
 * turns, not the live, tool-using agent loop). Full prior history is still
 * sent, so this is a real continuation of the conversation, just answered
 * later and cheaper, not an isolated one-off question.
 */
export async function submitBatch(
  anthropic: AnthropicBatchLike,
  model: string,
  systemPrompt: string,
  history: Anthropic.MessageParam[],
  userText: string,
): Promise<PendingBatch> {
  const customId = randomUUID();
  const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: userText }];

  const batch = await anthropic.messages.batches.create({
    requests: [
      {
        custom_id: customId,
        params: {
          model,
          max_tokens: 4096,
          system: cacheableSystem(systemPrompt),
          messages,
        },
      },
    ],
  });

  return {
    batchId: batch.id,
    customId,
    submittedAt: new Date().toISOString(),
    preview: userText.length > 80 ? `${userText.slice(0, 80)}…` : userText,
  };
}

/**
 * Checks one pending batch. Returns null if it's still processing — caller
 * should just leave it in the pending list and check again later.
 */
export async function checkBatch(
  anthropic: AnthropicBatchLike,
  entry: PendingBatch,
): Promise<BatchResolution | null> {
  const batch = await anthropic.messages.batches.retrieve(entry.batchId);
  if (batch.processing_status !== 'ended') return null;

  for await (const result of await anthropic.messages.batches.results(entry.batchId)) {
    if (result.custom_id !== entry.customId) continue;

    if (result.result.type === 'succeeded') {
      const text = result.result.message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      return { entry, status: 'succeeded', text };
    }
    if (result.result.type === 'errored') {
      return { entry, status: 'errored', errorDetail: result.result.error.error.message };
    }
    return { entry, status: result.result.type };
  }

  // Ended but no matching result — shouldn't happen for a single-request batch, but don't crash over it.
  return { entry, status: 'errored', errorDetail: 'brak wyniku dla tego custom_id w zakończonym batchu' };
}
