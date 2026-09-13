import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
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
  createGazetaItem,
  listGazetaItems,
  respondToGazetaItem,
  dismissGazetaItem,
  createBatchJob,
  listBatchJobs,
  resolveBatchJob,
  getPendingBatchJobs,
} from '../db.js';

/**
 * Exercises db.ts against a real SQLite file on disk (a fresh temp file per
 * run, deleted after) — not a mocked driver. This is the layer every other
 * piece (server.ts's routes, sse.ts's broadcasts, gazeta.ts's virtual tool)
 * ultimately reads and writes through, so correctness here — schema,
 * JSON round-tripping of message content, foreign-key-less cleanup — is
 * worth covering directly rather than only indirectly via route tests.
 *
 * Does NOT cover the Anthropic API round trip itself (anthropic-loop.ts) —
 * that needs a real or mocked model response, which is a separate,
 * heavier kind of test from this one.
 */
describe('db.ts integration', () => {
  let db: Database.Database;
  let dbFile: string;

  before(() => {
    dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'everythingapp-db-test-')), 'test.db');
    db = openDb(dbFile);
    runMigrations(db);
  });

  after(() => {
    db.close();
    fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
  });

  it('creates a conversation with defaults and reads it back', () => {
    const { id } = createConversation(db, {});
    const conv = getConversation(db, id);
    assert.ok(conv);
    assert.equal(conv!.title, 'New conversation');
    assert.equal(conv!.systemPrompt, null);
    assert.equal(conv!.sandboxEnabled, false);
  });

  it('lists conversations most-recently-updated first, with a live message count', () => {
    const a = createConversation(db, { title: 'A' });
    const b = createConversation(db, { title: 'B' });
    // updated_at has only second-level resolution (SQLite datetime('now')) —
    // two inserts a few ms apart in a test run can land in the same second
    // and tie, so back-date A explicitly instead of racing the clock.
    db.prepare(`UPDATE conversations SET updated_at = datetime('now', '-1 hour') WHERE id = ?`).run(a.id);
    appendMessage(db, b.id, 'user', 'hi'); // bumps B's updated_at to "now"

    const list = listConversations(db);
    const ids = list.map(c => c.id);
    assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id));
    assert.equal(list.find(c => c.id === b.id)!.messageCount, 1);
  });

  it('round-trips Anthropic-shaped message content through JSON storage, in order', () => {
    const { id } = createConversation(db, { title: 'roundtrip' });
    appendMessage(db, id, 'user', 'plain text content');
    appendMessage(db, id, 'assistant', [
      { type: 'text', text: 'thinking...' },
      { type: 'tool_use', id: 'call_1', name: 'sandbox__run_bash', input: { command: 'ls' } },
    ]);
    appendMessage(db, id, 'user', [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file.txt', is_error: false }]);

    const messages = getMessages(db, id);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].content, 'plain text content');
    assert.deepEqual(messages[1].content, [
      { type: 'text', text: 'thinking...' },
      { type: 'tool_use', id: 'call_1', name: 'sandbox__run_bash', input: { command: 'ls' } },
    ]);
    assert.deepEqual(messages[2].content, [
      { type: 'tool_result', tool_use_id: 'call_1', content: 'file.txt', is_error: false },
    ]);
  });

  it('clearMessages empties history without deleting the conversation itself', () => {
    const { id } = createConversation(db, { title: 'to clear' });
    appendMessage(db, id, 'user', 'will be cleared');
    clearMessages(db, id);
    assert.deepEqual(getMessages(db, id), []);
    assert.ok(getConversation(db, id));
  });

  it('updateConversation only touches the fields provided, and reports whether anything matched', () => {
    const { id } = createConversation(db, { title: 'original' });
    assert.equal(updateConversation(db, id, { model: 'claude-opus-5' }), true);
    const conv = getConversation(db, id);
    assert.equal(conv!.title, 'original'); // untouched
    assert.equal(conv!.model, 'claude-opus-5');
    assert.equal(updateConversation(db, 'does-not-exist', { title: 'x' }), false);
  });

  it('deleteConversation removes it and reports false for an unknown id', () => {
    const { id } = createConversation(db, { title: 'to delete' });
    assert.equal(deleteConversation(db, id), true);
    assert.equal(getConversation(db, id), null);
    assert.equal(deleteConversation(db, id), false);
  });

  it('settings: seeded defaults exist, and setSetting overwrites cleanly', () => {
    const seeded = getAllSettings(db);
    assert.ok('default_model' in seeded);
    assert.ok('custom_instructions' in seeded);

    setSetting(db, 'custom_instructions', 'be terse');
    assert.equal(getSetting(db, 'custom_instructions'), 'be terse');
    setSetting(db, 'custom_instructions', 'be terser'); // INSERT OR REPLACE, not a duplicate row
    assert.equal(getSetting(db, 'custom_instructions'), 'be terser');
  });

  it('gazeta: create → list as pending → respond moves it out of the pending list', () => {
    const { id: convId } = createConversation(db, { title: 'gazeta conv' });
    const itemId = createGazetaItem(db, {
      type: 'agent_question',
      conversationId: convId,
      title: 'Which region?',
      inputSchema: { type: 'choice', choices: ['eu', 'us'] },
    });

    const pending = listGazetaItems(db, 'pending');
    assert.ok(pending.some(i => i.id === itemId));
    assert.deepEqual(pending.find(i => i.id === itemId)!.inputSchema, { type: 'choice', choices: ['eu', 'us'] });

    assert.equal(respondToGazetaItem(db, itemId, { choice: 'eu' }), true);
    assert.equal(listGazetaItems(db, 'pending').some(i => i.id === itemId), false);
    const responded = listGazetaItems(db, 'responded').find(i => i.id === itemId);
    assert.deepEqual(responded!.response, { choice: 'eu' });
  });

  it('gazeta: dismiss also moves it out of the pending list', () => {
    const itemId = createGazetaItem(db, { type: 'daily_summary', title: 'Today' });
    assert.equal(dismissGazetaItem(db, itemId), true);
    assert.equal(listGazetaItems(db, 'pending').some(i => i.id === itemId), false);
  });

  it('batch jobs: created as pending, resolving removes it from the pending list', () => {
    const { id: convId } = createConversation(db, { title: 'batch conv' });
    createBatchJob(db, { id: 'batch_1', conversationId: convId, customId: 'req_1', userText: 'research X', preview: 'research X' });

    assert.ok(getPendingBatchJobs(db).some(j => j.id === 'batch_1'));
    resolveBatchJob(db, 'batch_1', 'succeeded', 'X is...');
    assert.equal(getPendingBatchJobs(db).some(j => j.id === 'batch_1'), false);

    const resolved = listBatchJobs(db, { conversationId: convId }).find(j => j.id === 'batch_1');
    assert.equal(resolved!.status, 'succeeded');
    assert.equal(resolved!.resultText, 'X is...');
  });
});
