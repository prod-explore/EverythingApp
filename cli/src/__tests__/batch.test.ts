import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { submitBatch, checkBatch, type AnthropicBatchLike } from '../batch.js';
import type { PendingBatch } from '../batch-store.js';

function fakeBatchClient(opts: {
  batchId?: string;
  processingStatus?: 'in_progress' | 'ended';
  result?: Anthropic.Messages.MessageBatchResult;
  customIdOverride?: string;
  captureCreate?: (params: Anthropic.Messages.BatchCreateParams) => void;
}): AnthropicBatchLike {
  const batchId = opts.batchId ?? 'batch_123';
  return {
    messages: {
      batches: {
        async create(params) {
          opts.captureCreate?.(params);
          return { id: batchId, processing_status: 'in_progress' } as unknown as Anthropic.Messages.MessageBatch;
        },
        async retrieve() {
          return {
            id: batchId,
            processing_status: opts.processingStatus ?? 'ended',
          } as unknown as Anthropic.Messages.MessageBatch;
        },
        async results() {
          const entries: Anthropic.Messages.MessageBatchIndividualResponse[] = opts.result
            ? [
                {
                  custom_id: opts.customIdOverride ?? 'will-be-set',
                  result: opts.result,
                } as unknown as Anthropic.Messages.MessageBatchIndividualResponse,
              ]
            : [];
          return (async function* () {
            for (const e of entries) yield e;
          })();
        },
      },
    },
  };
}

describe('submitBatch', () => {
  it('sends full history + new message, no tools, and returns a pending entry', async () => {
    let captured: Anthropic.Messages.BatchCreateParams | undefined;
    const client = fakeBatchClient({ captureCreate: p => (captured = p) });
    const history: Anthropic.MessageParam[] = [{ role: 'user', content: 'poprzednia wiadomość' }];

    const entry = await submitBatch(client, 'claude-sonnet-5', 'sys', history, 'nowa wiadomość');

    assert.equal(entry.batchId, 'batch_123');
    assert.equal(entry.preview, 'nowa wiadomość');
    assert.ok(entry.customId.length > 0);

    const req = captured?.requests[0];
    assert.equal(req?.params.tools, undefined);
    assert.deepEqual(req?.params.messages, [
      { role: 'user', content: 'poprzednia wiadomość' },
      { role: 'user', content: 'nowa wiadomość' },
    ]);
  });

  it('truncates long previews to 80 chars', async () => {
    const client = fakeBatchClient({});
    const longText = 'a'.repeat(200);
    const entry = await submitBatch(client, 'claude-sonnet-5', 'sys', [], longText);
    assert.equal(entry.preview.length, 81); // 80 chars + ellipsis
  });
});

describe('checkBatch', () => {
  const pendingEntry: PendingBatch = {
    batchId: 'batch_123',
    customId: 'custom-1',
    submittedAt: new Date().toISOString(),
    preview: 'test',
  };

  it('returns null while still processing', async () => {
    const client = fakeBatchClient({ processingStatus: 'in_progress' });
    const resolution = await checkBatch(client, pendingEntry);
    assert.equal(resolution, null);
  });

  it('extracts text from a succeeded result', async () => {
    const client = fakeBatchClient({
      customIdOverride: 'custom-1',
      result: {
        type: 'succeeded',
        message: { content: [{ type: 'text', text: 'odpowiedź z batcha' }] },
      } as unknown as Anthropic.Messages.MessageBatchResult,
    });

    const resolution = await checkBatch(client, pendingEntry);
    assert.equal(resolution?.status, 'succeeded');
    assert.equal(resolution?.text, 'odpowiedź z batcha');
  });

  it('surfaces an error message for an errored result', async () => {
    const client = fakeBatchClient({
      customIdOverride: 'custom-1',
      result: {
        type: 'errored',
        error: { error: { message: 'coś poszło nie tak' } },
      } as unknown as Anthropic.Messages.MessageBatchResult,
    });

    const resolution = await checkBatch(client, pendingEntry);
    assert.equal(resolution?.status, 'errored');
    assert.equal(resolution?.errorDetail, 'coś poszło nie tak');
  });
});
