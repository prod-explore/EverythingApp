import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SandboxManager, volumeName } from '../sandboxes.js';
import { createSupervisorApp } from '../api.js';
import { fakeOps } from './helpers.js';

describe('supervisor HTTP API', () => {
  let server: Server;
  let base: string;
  let mgr: SandboxManager;

  before(() => {
    mgr = new SandboxManager(fakeOps().ops);
    server = createSupervisorApp(mgr, 5000).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    server.close();
    await mgr.shutdown();
  });

  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };

  it('claim → terminal run → list → close → exec', async () => {
    const claim = await post('/claim', { ownerId: 'proj1' });
    assert.equal(claim.status, 200);
    assert.equal(claim.json.workspacePath, '/workspace');

    const run = await post('/terminal/run', { ownerId: 'proj1', terminal: 'dev', command: 'echo from-dev' });
    assert.equal(run.status, 200);
    assert.equal(run.json.output, 'from-dev\n');
    assert.equal(run.json.terminal, 'dev');

    const list = await (await fetch(`${base}/terminals?ownerId=proj1`)).json();
    assert.deepEqual(list.terminals.map((t: { name: string }) => t.name), ['dev']);

    assert.equal((await post('/terminal/close', { ownerId: 'proj1', terminal: 'dev' })).json.closed, true);

    const exec = await post(`/exec/${claim.json.containerId}`, { command: 'true' });
    assert.equal(exec.status, 200);
  });

  it('accepts the pre-N3 conversationId field as owner', async () => {
    assert.equal((await post('/claim', { conversationId: 'legacy-conv' })).status, 200);
  });

  it('validates input', async () => {
    assert.equal((await post('/claim', {})).status, 400);
    assert.equal((await post('/claim', { ownerId: '../etc' })).status, 400);
    assert.equal((await post('/terminal/run', { ownerId: 'p', command: '  ' })).status, 400);
    assert.equal((await post('/terminal/run', { ownerId: 'p', command: 'true', terminal: 'a b' })).status, 400);
    assert.equal((await fetch(`${base}/terminals`)).status, 400);
  });

  it('exec refuses unknown containers and stopped sandboxes', async () => {
    assert.equal((await post('/exec/not-a-container', { command: 'true' })).status, 404);
    const { json } = await post('/claim', { ownerId: 'to-stop' });
    await post('/release', { ownerId: 'to-stop' });
    assert.equal((await post(`/exec/${json.containerId}`, { command: 'true' })).status, 404);
  });

  it('health reports sandboxes', async () => {
    const h = await (await fetch(`${base}/health`)).json();
    assert.equal(h.status, 'ok');
    assert.ok(h.sandboxes.length >= 1);
    assert.ok(Array.isArray(h.warnings));
  });
});

describe('supervisor HTTP API — /sandboxes/:owner', () => {
  let server: Server;
  let base: string;
  let mgr: SandboxManager;
  let fake: ReturnType<typeof fakeOps>;

  before(() => {
    fake = fakeOps();
    mgr = new SandboxManager(fake.ops, { maxTerminals: 2, maxFileBytes: 1000, maxRunning: 4 });
    server = createSupervisorApp(mgr, 5000).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    server.close();
    await mgr.shutdown();
  });

  const json = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  it('invalid owner → 400 on every route', async () => {
    for (const p of ['/sandboxes/a.b/files', '/sandboxes/a%20b/file?path=x', '/sandboxes/' + 'x'.repeat(65) + '/checkpoints']) {
      assert.equal((await fetch(base + p)).status, 400, p);
    }
    assert.equal((await json('DELETE', '/sandboxes/..%2Fetc/volume')).status, 400);
  });

  it('status: null before, details after', async () => {
    assert.deepEqual((await json('GET', '/sandboxes/stat1')).json, { sandbox: null });
    await json('POST', '/claim', { ownerId: 'stat1' });
    const s = (await json('GET', '/sandboxes/stat1')).json.sandbox;
    assert.equal(s.running, true);
    assert.deepEqual(s.warnings, []);
    assert.ok('cpuPercent' in s && 'agentIdleMs' in s && 'terminals' in s);
  });

  it('files: empty listing for an owner without a sandbox', async () => {
    const r = await json('GET', '/sandboxes/nobody/files?path=/workspace');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { path: '/workspace', entries: [], truncated: false, empty: true });
  });

  it('files + file on a stopped sandbox (archive API), with confinement and size cap', async () => {
    await json('POST', '/claim', { ownerId: 'ex1' });
    fake.volumes
      .get(volumeName('ex1'))!
      .file('/workspace/docs/readme.md', '# Title')
      .file('/workspace/page.html', '<script>alert(1)</script>')
      .file('/workspace/big.txt', 'x'.repeat(1001))
      .symlink('/workspace/hosts', '/etc/hosts');
    await json('POST', '/release', { ownerId: 'ex1' });

    const l = await json('GET', '/sandboxes/ex1/files');
    assert.equal(l.status, 200);
    assert.deepEqual(
      l.json.entries.map((e: { name: string; type: string }) => `${e.name}:${e.type}`),
      ['docs:directory', 'big.txt:file', 'hosts:symlink', 'page.html:file'],
    );
    assert.equal((await json('GET', '/sandboxes/ex1/files?path=docs')).json.entries[0].path, '/workspace/docs/readme.md');

    const f = await fetch(`${base}/sandboxes/ex1/file?path=/workspace/docs/readme.md`);
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('content-type'), 'text/markdown');
    assert.equal(f.headers.get('x-file-size'), '7');
    assert.equal(await f.text(), '# Title');

    const html = await fetch(`${base}/sandboxes/ex1/file?path=page.html`);
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
    assert.match(html.headers.get('content-security-policy') ?? '', /sandbox/);
    await html.arrayBuffer();

    assert.equal((await json('GET', '/sandboxes/ex1/file?path=big.txt')).status, 413);
    assert.equal((await json('GET', '/sandboxes/ex1/file?path=hosts')).status, 400);
    assert.equal((await json('GET', '/sandboxes/ex1/file?path=docs')).status, 400);
    assert.equal((await json('GET', '/sandboxes/ex1/file?path=nope')).status, 404);
    assert.equal((await json('GET', '/sandboxes/ex1/file?path=/etc/passwd')).status, 400);
    assert.equal((await json('GET', '/sandboxes/ex1/files?path=/workspace/../etc')).status, 400);
    assert.equal((await json('GET', '/sandboxes/ex1/files?path=.ea-checkpoints')).status, 404);
    assert.equal(mgr.sandboxStatus('ex1')!.running, false, 'browsing did not start it');
  });

  it('terminal limit → 429 with a clear message', async () => {
    assert.equal((await json('POST', '/terminal/run', { ownerId: 'tl', terminal: 't1', command: 'true' })).status, 200);
    assert.equal((await json('POST', '/terminal/run', { ownerId: 'tl', terminal: 't2', command: 'true' })).status, 200);
    const r = await json('POST', '/terminal/run', { ownerId: 'tl', terminal: 't3', command: 'true' });
    assert.equal(r.status, 429);
    assert.match(r.json.error, /Terminal limit reached \(2\)/);
    assert.equal((await json('POST', '/terminal/run', { ownerId: 'tl', terminal: 't1', command: 'true' })).status, 200, 'existing ones still work');
  });

  it('DELETE /sandboxes/:owner/volume removes container and volume', async () => {
    await json('POST', '/claim', { ownerId: 'gone1' });
    assert.ok(fake.volumes.has(volumeName('gone1')));
    const r = await json('DELETE', '/sandboxes/gone1/volume');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, containersRemoved: 1, volumeRemoved: true });
    assert.equal(fake.volumes.has(volumeName('gone1')), false);
    assert.deepEqual((await json('GET', '/sandboxes/gone1')).json, { sandbox: null });
  });
});
