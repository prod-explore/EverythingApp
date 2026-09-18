import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Anthropic from '@anthropic-ai/sdk';
import { buildApp, type BuiltApp } from '../server.js';
import { openDb, runMigrations, getMessages, getAllMessagesFull } from '../db.js';

type Db = ReturnType<typeof openDb>;

const AUTH_TOKEN = 'branching-test-token';

/** Minimally-valid fake Anthropic.Message — mirrors integration.test.ts's helper. */
function fakeMessage(text: string): Anthropic.Message {
  return {
    id: 'msg_fake',
    container: null,
    content: [{ type: 'text', text, citations: null }],
    model: 'claude-sonnet-5',
    role: 'assistant',
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
  } as unknown as Anthropic.Message;
}

function fakeBatches() {
  return {
    create() { throw new Error('not exercised by this test'); },
    retrieve() { throw new Error('not exercised by this test'); },
    results() { throw new Error('not exercised by this test'); },
  };
}

/** Always replies with the same fixed text — used by the edit/regenerate/delete tests. */
function fixedReplyClient(replyText: string) {
  return { messages: { async create() { return fakeMessage(replyText); }, batches: fakeBatches() } };
}

/**
 * Throws on the first call (simulating the turn that leaves a user message
 * with no reply — see server.ts's kickoffLiveTurn error-handling comment)
 * and succeeds on every call after — used by the retry test.
 */
function failOnceThenSucceedClient(replyText: string) {
  let calls = 0;
  return {
    messages: {
      async create() {
        calls++;
        if (calls === 1) throw new Error('simulated transient failure');
        return fakeMessage(replyText);
      },
      batches: fakeBatches(),
    },
  };
}

interface JsonResponse { status: number; json: Record<string, unknown> }

function jsonRequest(port: number, method: string, path: string, body?: unknown): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${AUTH_TOKEN}`,
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} });
          } catch (err) {
            reject(new Error(`non-JSON response from ${path}: ${text} (${(err as Error).message})`));
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Polls GET .../messages until it has `count` rows or times out — turns run detached from the HTTP response. */
async function waitForMessageCount(port: number, convId: string, count: number, timeoutMs = 3000): Promise<Array<{ id: number; role: string; content: unknown }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await jsonRequest(port, 'GET', `/api/conversations/${convId}/messages`);
    const rows = res.json['messages'] as Array<{ id: number; role: string; content: unknown }>;
    if (rows.length >= count) return rows;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} messages (have ${rows.length})`);
    await new Promise(r => setTimeout(r, 20));
  }
}

async function setUp(anthropic: ReturnType<typeof fixedReplyClient>) {
  const db: Db = openDb(':memory:');
  runMigrations(db);
  const built: BuiltApp = await buildApp({
    db,
    connections: [],
    anthropic,
    authToken: AUTH_TOKEN,
    config: { model: 'claude-sonnet-5', autoApproveTools: [], webSearchEnabled: false },
  });
  const server = built.app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    db,
    port,
    async teardown() {
      built.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close();
    },
  };
}

describe('message branching: edit / regenerate / retry / delete', () => {
  it('edit retires the old branch and starts a new one with the edited text', async () => {
    const { port, db, teardown } = await setUp(fixedReplyClient('first reply'));
    try {
      const created = await jsonRequest(port, 'POST', '/api/conversations', {});
      const convId = created.json['id'] as string;

      await jsonRequest(port, 'POST', `/api/conversations/${convId}/message`, { content: 'original text' });
      const afterFirst = await waitForMessageCount(port, convId, 2);
      const userMsgId = afterFirst[0]!.id;

      const edited = await jsonRequest(port, 'POST', `/api/conversations/${convId}/edit`, {
        parentId: null,
        content: 'edited text',
      });
      assert.equal(edited.status, 200);
      assert.equal(edited.json['ok'], true);

      const afterEdit = await waitForMessageCount(port, convId, 2);
      // Still exactly 2 *active* messages — the old branch is retired, not left dangling alongside the new one.
      assert.equal(afterEdit.length, 2);
      assert.equal(JSON.stringify(afterEdit[0]!.content), JSON.stringify('edited text'));
      assert.notEqual(afterEdit[0]!.id, userMsgId); // a genuinely new row, not a mutation of the old one

      // The old branch is retired, not deleted — getAllMessagesFull sees 4 rows total (2 retired + 2 active).
      const full = getAllMessagesFull(db, convId);
      assert.equal(full.length, 4);
      const original = full.find(m => m.id === userMsgId)!;
      assert.equal(original.isActive, false);
      assert.equal(JSON.stringify(original.content), JSON.stringify('original text'));
    } finally {
      await teardown();
    }
  });

  it('regenerate re-sends the same user text and replaces only the assistant reply', async () => {
    const { port, teardown } = await setUp(fixedReplyClient('reply A'));
    try {
      const created = await jsonRequest(port, 'POST', '/api/conversations', {});
      const convId = created.json['id'] as string;

      await jsonRequest(port, 'POST', `/api/conversations/${convId}/message`, { content: 'question' });
      await waitForMessageCount(port, convId, 2);

      const regenerated = await jsonRequest(port, 'POST', `/api/conversations/${convId}/regenerate`, { parentId: null });
      assert.equal(regenerated.status, 200);

      const after = await waitForMessageCount(port, convId, 2);
      assert.equal(after.length, 2);
      assert.equal(JSON.stringify(after[0]!.content), JSON.stringify('question')); // user text unchanged
      assert.match(JSON.stringify(after[1]!.content), /reply A/); // fresh assistant reply generated again
    } finally {
      await teardown();
    }
  });

  it('retry re-sends a message that never got a reply (simulated turn failure)', async () => {
    const { port, teardown } = await setUp(failOnceThenSucceedClient('recovered reply'));
    try {
      const created = await jsonRequest(port, 'POST', '/api/conversations', {});
      const convId = created.json['id'] as string;

      await jsonRequest(port, 'POST', `/api/conversations/${convId}/message`, { content: 'will fail once' });
      // The simulated failure leaves exactly the user message, no reply — this is the fixed
      // behavior from the disappearing-messages bug: the message is never rolled back.
      const afterFailure = await waitForMessageCount(port, convId, 1);
      assert.equal(afterFailure.length, 1);
      assert.equal(afterFailure[0]!.role, 'user');

      const retried = await jsonRequest(port, 'POST', `/api/conversations/${convId}/retry`, {});
      assert.equal(retried.status, 200);

      const afterRetry = await waitForMessageCount(port, convId, 2);
      assert.equal(afterRetry.length, 2);
      assert.match(JSON.stringify(afterRetry[1]!.content), /recovered reply/);
    } finally {
      await teardown();
    }
  });

  it('deleting a message removes it and everything after it', async () => {
    const { port, teardown } = await setUp(fixedReplyClient('reply'));
    try {
      const created = await jsonRequest(port, 'POST', '/api/conversations', {});
      const convId = created.json['id'] as string;

      await jsonRequest(port, 'POST', `/api/conversations/${convId}/message`, { content: 'first' });
      const afterFirst = await waitForMessageCount(port, convId, 2);
      const firstUserMsgId = afterFirst[0]!.id;

      await jsonRequest(port, 'POST', `/api/conversations/${convId}/message`, { content: 'second' });
      await waitForMessageCount(port, convId, 4);

      const deleted = await jsonRequest(port, 'DELETE', `/api/conversations/${convId}/messages/${firstUserMsgId}`);
      assert.equal(deleted.status, 200);

      const after = await jsonRequest(port, 'GET', `/api/conversations/${convId}/messages`);
      assert.equal((after.json['messages'] as unknown[]).length, 0);
    } finally {
      await teardown();
    }
  });

  it('regenerate on a nonexistent conversation returns 404', async () => {
    const { port, teardown } = await setUp(fixedReplyClient('unused'));
    try {
      const res = await jsonRequest(port, 'POST', '/api/conversations/does-not-exist/regenerate', { parentId: null });
      assert.equal(res.status, 404);
    } finally {
      await teardown();
    }
  });
});
