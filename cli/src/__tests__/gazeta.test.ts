import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb, runMigrations, createConversation, listGazetaItems, type BatchJob } from '../db.js';
import { handleRequestHumanInput, createBatchResultItem } from '../gazeta.js';

/**
 * Covers handleRequestHumanInput's three input-schema shapes (text, choice,
 * fields) and createBatchResultItem — the pieces Phase 5 touches. Full
 * round-trip through respondToGazetaItem/dismissGazetaItem is already
 * covered by db.test.ts; this file is about gazeta.ts's own schema-shaping
 * logic, not the storage layer underneath it.
 */
describe('gazeta', () => {
  let db: Database.Database;
  let tmpPath: string;
  let conversationId: string;

  before(() => {
    tmpPath = path.join(os.tmpdir(), `gazeta-test-${Date.now()}.db`);
    db = openDb(tmpPath);
    runMigrations(db);
    conversationId = createConversation(db, { title: 'test convo' }).id;
  });

  after(() => {
    db.close();
    try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
  });

  it('defaults to a text schema when neither choices nor fields are given', () => {
    handleRequestHumanInput(db, conversationId, { title: 'T', description: 'D' });
    const [item] = listGazetaItems(db, 'pending');
    assert.deepEqual(item.inputSchema, { type: 'text' });
    assert.equal(item.type, 'agent_question');
    assert.equal(item.conversationId, conversationId);
  });

  it('builds a choice schema when choices are given', () => {
    handleRequestHumanInput(db, conversationId, { title: 'T2', description: 'D2', choices: ['Yes', 'No'] });
    const item = listGazetaItems(db, 'pending').find(i => i.title === 'T2')!;
    assert.deepEqual(item.inputSchema, { type: 'choice', choices: ['Yes', 'No'] });
  });

  it('treats an empty choices array as no choices (falls back to text)', () => {
    handleRequestHumanInput(db, conversationId, { title: 'T3', description: 'D3', choices: [] });
    const item = listGazetaItems(db, 'pending').find(i => i.title === 'T3')!;
    assert.deepEqual(item.inputSchema, { type: 'text' });
  });

  it('builds a fields schema when fields are given', () => {
    const fields = [
      { name: 'name', label: 'Your name' },
      { name: 'reason', label: 'Reason', type: 'text' as const },
    ];
    handleRequestHumanInput(db, conversationId, { title: 'T4', description: 'D4', fields });
    const item = listGazetaItems(db, 'pending').find(i => i.title === 'T4')!;
    assert.deepEqual(item.inputSchema, { type: 'fields', fields });
  });

  it('preserves select-type fields with their options', () => {
    const fields = [{ name: 'size', label: 'Size', type: 'select' as const, options: ['S', 'M', 'L'] }];
    handleRequestHumanInput(db, conversationId, { title: 'T5', description: 'D5', fields });
    const item = listGazetaItems(db, 'pending').find(i => i.title === 'T5')!;
    assert.deepEqual(item.inputSchema, { type: 'fields', fields });
  });

  it('fields takes priority over choices when both are present', () => {
    const fields = [{ name: 'x', label: 'X' }];
    handleRequestHumanInput(db, conversationId, {
      title: 'T6',
      description: 'D6',
      choices: ['A', 'B'],
      fields,
    });
    const item = listGazetaItems(db, 'pending').find(i => i.title === 'T6')!;
    assert.deepEqual(item.inputSchema, { type: 'fields', fields });
  });

  it('createBatchResultItem creates a batch_result item titled from the job preview', () => {
    const job: BatchJob = {
      id: 'job-1',
      conversationId,
      customId: 'custom-1',
      userText: 'user text',
      preview: 'summarize this doc',
      status: 'resolved',
      resultText: 'Here is the summary.',
      submittedAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
    };
    createBatchResultItem(db, job);
    const item = listGazetaItems(db, 'pending').find(i => i.type === 'batch_result')!;
    assert.equal(item.title, 'Batch result: summarize this doc');
    assert.equal(item.description, 'Here is the summary.');
    assert.equal(item.conversationId, conversationId);
  });

  it('createBatchResultItem falls back to a placeholder when resultText is null', () => {
    const job: BatchJob = {
      id: 'job-2',
      conversationId,
      customId: 'custom-2',
      userText: 'user text',
      preview: 'no result yet',
      status: 'resolved',
      resultText: null,
      submittedAt: new Date().toISOString(),
      resolvedAt: null,
    };
    createBatchResultItem(db, job);
    const item = listGazetaItems(db, 'pending').find(i => i.title === 'Batch result: no result yet')!;
    assert.equal(item.description, '*(no response text)*');
  });
});
