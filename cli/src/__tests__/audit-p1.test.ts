import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp, type BuiltApp } from '../server.js';
import { appendMessage, openDb, runMigrations } from '../db.js';
import { ProviderRouter } from '../providers/router.js';
import { isUserTurn, planCompaction } from '../context.js';
import { truncateToolOutput } from '../output-truncator.js';
import type * as Llm from '../llm-types.js';

const TOKEN = 'test-token';

function get(port: number, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { authorization: `Bearer ${TOKEN}` } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

describe('conversation export (audit S2)', () => {
  let built: BuiltApp; let server: http.Server; let port: number; let db: ReturnType<typeof openDb>;
  before(async () => {
    db = openDb(':memory:'); runMigrations(db);
    const router = new ProviderRouter({ db, env: {} as NodeJS.ProcessEnv, fetchImpl: (async () => new Response('{}')) as typeof fetch });
    built = await buildApp({ db, connections: [], router, authToken: TOKEN, config: { model: '@test/model-a', autoApproveTools: [] } });
    server = built.app.listen(0); port = (server.address() as AddressInfo).port;
  });
  after(() => { built.stop(); server.close(); db.close(); });

  const create = (title: string): string => {
    const id = `c-${Math.random().toString(36).slice(2)}`;
    db.prepare('INSERT INTO conversations (id, title) VALUES (?, ?)').run(id, title);
    appendMessage(db, id, 'user', 'hello');
    return id;
  };

  for (const format of ['json', 'md']) {
    it(`exports ${format} for a title with characters above U+00FF instead of failing with 500`, async () => {
      const id = create('Zażółć gęślą jaźń — 日本語 "quoted"');
      const r = await get(port, `/api/conversations/${id}/export?format=${format}`);
      assert.equal(r.status, 200);
      const cd = String(r.headers['content-disposition']);
      assert.match(cd, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
      assert.ok(cd.includes(encodeURIComponent('Zażółć')), 'the UTF-8 name is carried in filename*');
      assert.ok(cd.endsWith(`.${format}`), 'keeps the extension');
    });
  }

  it('falls back to a plain name for an empty title', async () => {
    const id = create('');
    const r = await get(port, `/api/conversations/${id}/export?format=json`);
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-disposition']), /filename="conversation\.json"/);
  });
});

describe('compaction never cuts between a tool_use and its tool_result (audit S3)', () => {
  const user = (t: string): Llm.MessageParam => ({ role: 'user', content: t });
  const asst = (t: string): Llm.MessageParam => ({ role: 'assistant', content: [{ type: 'text', text: t }] });
  const use = (id: string): Llm.MessageParam => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_file', input: {} }] });
  const res = (id: string, ...extra: string[]): Llm.MessageParam => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }, ...extra.map(text => ({ type: 'text' as const, text }))],
  });

  it('a tool_result message with appended inbox text is not a turn start', () => {
    assert.equal(isUserTurn(res('t', 'message from another agent')), false);
    assert.equal(isUserTurn(user('hi')), true);
    assert.equal(isUserTurn({ role: 'user', content: [{ type: 'text', text: 'hi' }] }), true);
    assert.equal(isUserTurn({ role: 'user', content: [] }), false);
  });

  it('the row sequence from the audit never produces an orphan cut', () => {
    // [A, tu, tr, a, B, tu(t1), tr(t1)+inbox, a, C, a], keepTurns 2
    const rows = [user('A'), use('t0'), res('t0'), asst('a'), user('B'), use('t1'), res('t1', 'inbox'), asst('a'), user('C'), asst('a')];
    const cut = planCompaction(rows, { keepTurns: 2 })!;
    assert.equal(cut, 4, 'cuts at the user turn B, not at the tool_result carrier');
    assert.equal(isUserTurn(rows[cut]!), true);
  });

  it('refuses to cut when the only candidate starts with a tool_result', () => {
    const rows = [user('A'), asst('a'), asst('b'), res('x'), asst('c')];
    assert.equal(planCompaction(rows, { keepTurns: 1 }), null);
  });
});

describe('tool output truncation (audit S5)', () => {
  it('says what happened without promising a full copy elsewhere', () => {
    const r = truncateToolOutput('a'.repeat(30_000), 1000);
    assert.equal(r.wasTruncated, true);
    assert.match(r.truncated, /characters truncated from the middle/);
    assert.ok(!/UI/.test(r.truncated));
  });

  it('leaves short output untouched', () => {
    assert.deepEqual(truncateToolOutput('short'), { truncated: 'short', wasTruncated: false });
  });
});
