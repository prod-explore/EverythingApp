import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { PolicyStore, mergeCommandPolicy, parsePolicyFile } from '../policy-file.js';
import { parseCommandPolicy } from '../command-policy.js';
import { WebApprovalGate } from '../web-approval.js';
import { runMigrations, createProject } from '../db.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ea-policy-')), 'policy.json');

describe('policy.json', () => {
  it('creates a documented default on first read', () => {
    const path = tmp();
    const p = new PolicyStore(path).get();
    assert.ok(p.commands.deny.includes('git push --force'));
    assert.match(readFileSync(path, 'utf8'), /_help/);
  });
  it('hot-reloads on edit, and a typo keeps the last good policy', () => {
    const path = tmp();
    const store = new PolicyStore(path);
    store.get();
    writeFileSync(path, JSON.stringify({ commands: { allow: ['npm test'], deny: ['rm -rf'] } }));
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    assert.deepEqual(store.get().commands.allow, ['npm test']);
    writeFileSync(path, '{ not json');
    utimesSync(path, new Date(), new Date(Date.now() + 10000));
    assert.deepEqual(store.get().commands.deny, ['rm -rf']);
    assert.ok(store.lastError);
  });
  it('parses junk into safe defaults', () => {
    const p = parsePolicyFile({ commands: 5, browser: { js: 'weird', domainAllow: ['a.com', 3] } });
    assert.equal(p.browser.js, 'allowed');
    assert.deepEqual(p.browser.domainAllow, ['a.com']);
    assert.deepEqual(p.commands.allow, []);
  });
  it('merge: file deny always applies; project can add; file mode is only a default', () => {
    const file = { allow: ['ls'], deny: ['docker'], domains: ['github.com'], mode: 'auto' as const };
    const proj = parseCommandPolicy({ allow: ['make'], deny: ['curl'], domains: [] });
    const m = mergeCommandPolicy(file, proj, false);
    assert.deepEqual(m.deny, ['docker', 'curl']);
    assert.deepEqual(m.allow, ['ls', 'make']);
    assert.equal(m.mode, 'auto');
    assert.equal(mergeCommandPolicy(file, parseCommandPolicy({ mode: 'strict' }), true).mode, 'strict');
  });
  it('the approval gate honours the file: allow runs without a prompt, deny is refused', async () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ commands: { mode: 'strict', allow: ['npm test'], deny: ['docker'] } }));
    const db = new Database(':memory:');
    runMigrations(db);
    const project = createProject(db, { name: 'p' });
    const gate = new WebApprovalGate(db, new PolicyStore(path));
    const ctx = { projectId: project.id };
    assert.equal((await gate.confirmDetailed('c1', 'sandbox/run_bash', { command: 'npm test' }, undefined, ctx)).approved, true);
    const denied = await gate.confirmDetailed('c1', 'sandbox/run_bash', { command: 'docker ps' }, undefined, ctx);
    assert.equal(denied.approved, false);
    assert.match(String(denied.reason), /blocked by the project command policy/);
  });
});
