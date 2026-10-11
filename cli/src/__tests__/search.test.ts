import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations, createConversation, appendMessage, deleteConversation } from '../db.js';
import { searchMessages, toFtsQuery, exportMarkdown } from '../search.js';

describe('FTS5 message search', () => {
  it('finds text, prefixes, diacritics; ignores tool plumbing, subagents and deleted chats', () => {
    const db = openDb(':memory:'); runMigrations(db);
    const a = createConversation(db, { title: 'Deploy notes' }).id;
    const sub = createConversation(db, { title: 'sub', kind: 'subagent' }).id;
    appendMessage(db, a, 'user', 'How do I configure nginx reverse proxy?');
    appendMessage(db, a, 'assistant', [{ type: 'text', text: 'Użyj proxy_pass w bloku location.' }, { type: 'tool_use', id: 't', name: 'secretTool', input: { q: 'zzzunique' } }]);
    appendMessage(db, sub, 'user', 'nginx inside a worker');
    let hits = searchMessages(db, 'nginx');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.title, 'Deploy notes');
    assert.match(hits[0]!.snippet, /⟦nginx⟧/);
    assert.equal(searchMessages(db, 'uzyj proxy').length, 1, 'prefix + diacritics-insensitive');
    assert.equal(searchMessages(db, 'zzzunique').length, 0, 'tool inputs are not indexed');
    deleteConversation(db, a);
    assert.equal(searchMessages(db, 'nginx').length, 0, 'deleted chats leave the index');
  });

  it('is injection-safe', () => {
    assert.equal(toFtsQuery('  '), null);
    assert.equal(toFtsQuery('foo" OR bar*'), '"foo"* "OR"* "bar"*');
    const db = openDb(':memory:'); runMigrations(db);
    assert.deepEqual(searchMessages(db, 'NEAR( AND "'), []);
  });

  it('exports Markdown', () => {
    const md = exportMarkdown('T', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'yo' }, { type: 'tool_use', name: 'bash' }] }, { role: 'user', content: [{ type: 'tool_result' }] }]);
    assert.match(md, /^# T\n\n## You\n\nhi\n\n## Assistant\n\nyo\n\n\*Used tools: bash\*/);
    assert.ok(!md.includes('tool_result'));
  });
});
