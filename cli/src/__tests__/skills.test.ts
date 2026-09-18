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
  createSkill,
  listSkills,
  getSkill,
  updateSkill,
  deleteSkill,
  getConversationSkills,
  attachSkill,
  detachSkill,
} from '../db.js';

describe('Skills CRUD', () => {
  let db: Database.Database;
  let tmpPath: string;

  before(() => {
    tmpPath = path.join(os.tmpdir(), `skills-test-${Date.now()}.db`);
    db = openDb(tmpPath);
    runMigrations(db);
  });

  after(() => {
    db.close();
    try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
  });

  it('creates a skill with defaults', () => {
    const s = createSkill(db, { name: 'Code Reviewer' });
    assert.equal(s.name, 'Code Reviewer');
    assert.equal(s.description, '');
    assert.equal(s.prompt, '');
    assert.deepEqual(s.allowedTools, []);
    assert.ok(s.id);
    assert.ok(s.createdAt);
  });

  it('creates a skill with all fields', () => {
    const s = createSkill(db, {
      name: 'Polish Writer',
      description: 'Writes in Polish',
      prompt: 'Always reply in Polish.',
      allowedTools: ['obsidian__write_note'],
    });
    assert.equal(s.name, 'Polish Writer');
    assert.equal(s.description, 'Writes in Polish');
    assert.equal(s.prompt, 'Always reply in Polish.');
    assert.deepEqual(s.allowedTools, ['obsidian__write_note']);
  });

  it('listSkills returns all skills in creation order', () => {
    const before = listSkills(db).length;
    createSkill(db, { name: 'Z Skill' });
    createSkill(db, { name: 'A Skill' });
    const after = listSkills(db);
    assert.ok(after.length >= before + 2);
    // Created order: Z first, A second (ASC by created_at)
    const names = after.map(s => s.name);
    const zIdx = names.indexOf('Z Skill');
    const aIdx = names.indexOf('A Skill');
    assert.ok(zIdx < aIdx, 'Z Skill should appear before A Skill (creation order)');
  });

  it('getSkill returns the skill or null', () => {
    const s = createSkill(db, { name: 'Temp Skill' });
    const found = getSkill(db, s.id);
    assert.ok(found);
    assert.equal(found.id, s.id);
    assert.equal(getSkill(db, 'nonexistent'), null);
  });

  it('updateSkill patches individual fields without touching others', () => {
    const s = createSkill(db, { name: 'Old Name', prompt: 'Old prompt', allowedTools: ['tool_a'] });
    const ok = updateSkill(db, s.id, { name: 'New Name', allowedTools: ['tool_b', 'tool_c'] });
    assert.equal(ok, true);
    const updated = getSkill(db, s.id)!;
    assert.equal(updated.name, 'New Name');
    assert.equal(updated.prompt, 'Old prompt'); // unchanged
    assert.deepEqual(updated.allowedTools, ['tool_b', 'tool_c']);
  });

  it('updateSkill with no fields returns false', () => {
    const s = createSkill(db, { name: 'Unchanged' });
    const ok = updateSkill(db, s.id, {});
    assert.equal(ok, false);
  });

  it('deleteSkill removes the skill and returns false on re-delete', () => {
    const s = createSkill(db, { name: 'Doomed' });
    assert.equal(deleteSkill(db, s.id), true);
    assert.equal(deleteSkill(db, s.id), false);
    assert.equal(getSkill(db, s.id), null);
  });

  it('attachSkill / getConversationSkills / detachSkill round-trip', () => {
    const { id: convId } = createConversation(db, { title: 'Test conv' });
    const s1 = createSkill(db, { name: 'Skill 1', prompt: 'Prompt 1' });
    const s2 = createSkill(db, { name: 'Skill 2', prompt: 'Prompt 2' });

    assert.equal(getConversationSkills(db, convId).length, 0);

    attachSkill(db, convId, s1.id);
    attachSkill(db, convId, s2.id);
    // Idempotent (INSERT OR IGNORE)
    attachSkill(db, convId, s1.id);

    const attached = getConversationSkills(db, convId);
    assert.equal(attached.length, 2);
    assert.ok(attached.some(s => s.id === s1.id));
    assert.ok(attached.some(s => s.id === s2.id));

    assert.equal(detachSkill(db, convId, s1.id), true);
    assert.equal(getConversationSkills(db, convId).length, 1);
    assert.equal(detachSkill(db, convId, s1.id), false); // already detached
  });

  it('deleting a skill automatically detaches it from conversations (CASCADE)', () => {
    const { id: convId } = createConversation(db, { title: 'Cascade test conv' });
    const s = createSkill(db, { name: 'Cascadeable' });
    attachSkill(db, convId, s.id);
    assert.equal(getConversationSkills(db, convId).length, 1);

    deleteSkill(db, s.id);
    assert.equal(getConversationSkills(db, convId).length, 0);
  });
});
