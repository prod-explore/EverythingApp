import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Anthropic from '@anthropic-ai/sdk';
import { buildApp } from '../server.js';
import { openDb, runMigrations, listGazetaItems, getMessages } from '../db.js';

/**
 * Regression for the 2026-09-29 audit: request_human_input used to be treated as an MCP tool
 * ("Unknown tool" result + a raw-JSON approval prompt) and its Gazeta item was created by
 * scanning the WHOLE history after the turn — so every later turn created a duplicate.
 */
const TOKEN = 't';
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null };
const msg = (content: unknown[], stop: string) =>
  ({ id: 'm', container: null, content, model: 'claude-sonnet-5', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message', usage }) as unknown as Anthropic.Message;

function req(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request(
      { host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } },
      res => {
        const c: Buffer[] = [];
        res.on('data', d => c.push(d));
        res.on('end', () => {
          const t = Buffer.concat(c).toString();
          resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 20));
  }
};

describe('request_human_input as an in-loop virtual tool', () => {
  it('creates exactly one Gazeta item, never hits the approval gate, gives the model a real result, and does not duplicate on later turns', async () => {
    const seen: Anthropic.MessageParam[][] = [];
    let call = 0;
    const client = {
      messages: {
        async create(p: Anthropic.MessageCreateParamsNonStreaming) {
          seen.push(JSON.parse(JSON.stringify(p.messages)));
          call++;
          if (call === 1) return msg([{ type: 'tool_use', id: 'toolu_1', name: 'request_human_input', input: { title: 'Q1', description: 'details' } }], 'tool_use');
          return msg([{ type: 'text', text: `reply ${call}`, citations: null }], 'end_turn');
        },
        batches: { create() { throw new Error('unused'); }, retrieve() { throw new Error('unused'); }, results() { throw new Error('unused'); } },
      },
    };
    const db = openDb(':memory:');
    runMigrations(db);
    const built = await buildApp({ db, connections: [], anthropic: client as any, authToken: TOKEN, config: { model: 'claude-sonnet-5', autoApproveTools: [], webSearchEnabled: false } });
    const server = built.app.listen(0);
    await new Promise<void>(r => server.once('listening', () => r()));
    const port = (server.address() as AddressInfo).port;

    try {
      const conv = (await req(port, 'POST', '/api/conversations', {})).json.id as string;
      await req(port, 'POST', `/api/conversations/${conv}/message`, { text: 'ask me something' });
      await waitFor(() => listGazetaItems(db).length === 1);

      // Blocking mode (N1): the turn parks on the human's answer, so the model has not been called again yet.
      assert.equal(call, 1);
      const answered = await req(port, 'POST', `/api/gazeta/${listGazetaItems(db)[0]!.id}/respond`, { response: 'yes' });
      assert.equal(answered.status, 200);

      await waitFor(() => call >= 2);
      await waitFor(() => getMessages(db, conv).length >= 4);

      assert.deepEqual((await req(port, 'GET', '/api/pending-approvals')).json.pending, [], 'virtual tool must not park in the approval gate');
      assert.equal(listGazetaItems(db).length, 1);

      const toolResult = (seen[1]!.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
      assert.equal(toolResult.tool_use_id, 'toolu_1');
      assert.notEqual(toolResult.is_error, true);
      assert.match(String(toolResult.content), /User responded.*yes/);

      // A second, unrelated turn must not re-create the item from old history.
      await req(port, 'POST', `/api/conversations/${conv}/message`, { text: 'another message' });
      await waitFor(() => call >= 3);
      await waitFor(() => getMessages(db, conv).length >= 6);
      assert.equal(listGazetaItems(db).length, 1, 'no duplicate Gazeta item after a later turn');
    } finally {
      built.stop();
      server.close();
      db.close();
    }
  });
});
