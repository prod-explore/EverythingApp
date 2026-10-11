import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { cacheableSystem, sanitizeHistory, type LlmClient } from './anthropic-loop.js';

export interface PendingBatch {
  batchId: string;
  customId: string;
  submittedAt: string;
  /** First ~80 chars of the user's message, just so a status list is human-readable. */
  preview: string;
}

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
  /** Token usage of the batched call, only set when status is 'succeeded' — feeds the spend ledger (billed at the batch discount). */
  usage?: Anthropic.Usage;
  /** Model that actually answered, as reported by the API. */
  model?: string;
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
  const messages: Anthropic.MessageParam[] = [...sanitizeHistory(history), { role: 'user', content: userText }];

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
      return { entry, status: 'succeeded', text, usage: result.result.message.usage, model: result.result.message.model };
    }
    if (result.result.type === 'errored') {
      return { entry, status: 'errored', errorDetail: result.result.error.error.message };
    }
    return { entry, status: result.result.type };
  }

  // Ended but no matching result — shouldn't happen for a single-request batch, but don't crash over it.
  return { entry, status: 'errored', errorDetail: 'brak wyniku dla tego custom_id w zakończonym batchu' };
}

export interface BatchedClientOptions {
  /** How often to ask whether the batch has ended. Anthropic batches usually finish within an hour, at most 24 h. */
  pollMs?: number;
  /** Give up after this long (Anthropic expires batches at 24 h). */
  timeoutMs?: number;
  /** Called once per submitted step — lets the owner show "waiting for batch …" and persist the id. */
  onSubmitted?: (batchId: string) => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * An LlmClient whose every `messages.create` is a one-request Batch API job (50% cheaper per call).
 *
 * This is what makes tool-using work batchable: the normal agent loop keeps running unchanged, and each model
 * step becomes   submit → poll → result → (run tool locally, behind the same approval gate) → submit …
 * An approval step simply waits for a human *between* two batches; nothing is held at Anthropic while it does.
 * Trade-off: latency per step is minutes, not seconds — use it for background workers, never for the live chat.
 */
export function createBatchedClient(batches: AnthropicBatchLike, opts: BatchedClientOptions = {}): LlmClient {
  const pollMs = opts.pollMs ?? 20_000;
  const timeoutMs = opts.timeoutMs ?? 24 * 60 * 60 * 1000;
  return {
    messages: {
      create: (async (params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }) => {
        const signal = options?.signal;
        const customId = randomUUID();
        // Same hygiene as submitBatch: no stream flag, cacheable system prompt, sanitized history.
        const { stream: _stream, ...rest } = params as Anthropic.MessageCreateParamsNonStreaming & { stream?: boolean };
        const system = typeof rest.system === 'string' ? cacheableSystem(rest.system) : rest.system;
        const batch = await batches.messages.batches.create({
          requests: [{ custom_id: customId, params: { ...rest, system, messages: sanitizeHistory(rest.messages) } }],
        });
        opts.onSubmitted?.(batch.id);
        const started = Date.now();
        for (;;) {
          const st = await batches.messages.batches.retrieve(batch.id);
          if (st.processing_status === 'ended') break;
          if (Date.now() - started > timeoutMs) throw new Error(`batch ${batch.id} did not finish within ${Math.round(timeoutMs / 3_600_000)} h`);
          await sleep(pollMs, signal);
        }
        for await (const result of await batches.messages.batches.results(batch.id)) {
          if (result.custom_id !== customId) continue;
          if (result.result.type === 'succeeded') return result.result.message;
          if (result.result.type === 'errored') throw new Error(`batch step failed: ${result.result.error.error.message}`);
          throw new Error(`batch step ${result.result.type}`);
        }
        throw new Error(`batch ${batch.id} ended without a result for this step`);
      }) as LlmClient['messages']['create'],
    },
  };
}
