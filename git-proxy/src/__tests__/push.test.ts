import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRefs, decidePush, githubCompare, type ClassifiedRef } from '../push.js';
import { listen, sha, ZERO } from './helpers.js';

describe('ref classification', () => {
  it('create / delete / update with force detection from compare status', async () => {
    const statuses: Record<string, string | null> = { [sha('2')]: 'ahead', [sha('3')]: 'diverged', [sha('4')]: 'behind', [sha('5')]: null, [sha('6')]: 'identical' };
    const asked: string[] = [];
    const refs = await classifyRefs(
      [
        { old: ZERO, new: sha('1'), ref: 'refs/heads/new' },
        { old: sha('9'), new: ZERO, ref: 'refs/heads/gone' },
        { old: sha('1'), new: sha('2'), ref: 'refs/heads/ff' },
        { old: sha('1'), new: sha('3'), ref: 'refs/heads/rewritten' },
        { old: sha('1'), new: sha('4'), ref: 'refs/heads/reset' },
        { old: sha('1'), new: sha('5'), ref: 'refs/heads/unknown' },
        { old: sha('1'), new: sha('6'), ref: 'refs/heads/same' },
      ],
      async (base, head) => {
        asked.push(`${base}...${head}`);
        return statuses[head] ?? null;
      },
    );
    assert.deepEqual(
      refs.map(r => [r.ref, r.kind, r.force]),
      [
        ['refs/heads/new', 'create', false],
        ['refs/heads/gone', 'delete', false],
        ['refs/heads/ff', 'update', false],
        ['refs/heads/rewritten', 'update', true],
        ['refs/heads/reset', 'update', true],
        ['refs/heads/unknown', 'update', null],
        ['refs/heads/same', 'update', false],
      ],
    );
    // compare is only consulted for updates
    assert.equal(asked.length, 5);
    assert.ok(asked.includes(`${sha('1')}...${sha('3')}`));
  });
});

describe('push policy', () => {
  const ref = (over: Partial<ClassifiedRef>): ClassifiedRef => ({ ref: 'refs/heads/feature', old: sha('1'), new: sha('2'), kind: 'update', force: false, ...over });
  const prot = ['main', 'master'];

  it('deny always rejects, ask always asks', () => {
    assert.equal(decidePush('deny', [ref({})], prot).action, 'deny');
    assert.equal(decidePush('ask', [ref({})], prot).action, 'ask');
  });

  it('allow skips approval for fast-forwards and creates', () => {
    assert.equal(decidePush('allow', [ref({}), ref({ kind: 'create', old: ZERO })], prot).action, 'allow');
    assert.equal(decidePush('allow', [ref({ ref: 'refs/heads/main', force: false })], prot).action, 'allow');
    assert.equal(decidePush('allow', [ref({ force: null })], prot).action, 'allow'); // unverified, but not protected
  });

  it('allow still asks for delete, force, and unverified protected-branch updates', () => {
    assert.match(decidePush('allow', [ref({ kind: 'delete', new: ZERO })], prot).reason, /deletes/);
    assert.equal(decidePush('allow', [ref({ kind: 'delete', new: ZERO })], prot).action, 'ask');
    assert.equal(decidePush('allow', [ref({ force: true })], prot).action, 'ask');
    assert.equal(decidePush('allow', [ref({ ref: 'refs/heads/main', force: null })], prot).action, 'ask');
  });
});

describe('githubCompare', () => {
  it('calls GET /repos/:o/:r/compare/:old...:new with the project token; 404 -> null', async () => {
    const seen: { url: string; auth?: string }[] = [];
    const api = await listen((req, res) => {
      seen.push({ url: req.url!, auth: req.headers.authorization });
      if (req.url!.includes(sha('f'))) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'diverged' }));
    });
    try {
      const compare = githubCompare(api.url, { getGithubToken: async p => `tok-${p}` });
      assert.equal(await compare('p1', 'acme', 'app', sha('a'), sha('b')), 'diverged');
      assert.equal(await compare('p1', 'acme', 'app', sha('a'), sha('f')), null);
      assert.equal(seen[0]!.url, `/repos/acme/app/compare/${sha('a')}...${sha('b')}?per_page=1`);
      assert.equal(seen[0]!.auth, 'Bearer tok-p1');
    } finally {
      await api.close();
    }
  });
});
