import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SandboxManager, previewHost, previewNetworkName } from '../sandboxes.js';
import { createSupervisorApp } from '../api.js';
import { fakeOps } from './helpers.js';

const BROWSER = 'everythingapp-playwright-mcp';

describe('preview link (sandbox ↔ shared browser)', () => {
  it('the host is a stable, hostname-safe function of the owner id', () => {
    assert.equal(previewHost('abc'), 'sandbox-a9993e3647');
    assert.equal(previewHost('abc'), previewHost('abc'));
    assert.notEqual(previewHost('abc'), previewHost('abd'));
    assert.match(previewHost('proj-1'), /^sandbox-[0-9a-f]{10}$/);
    assert.match(previewNetworkName('proj-1'), /^ea-preview-[0-9a-f]{16}$/);
  });

  it('claims the sandbox and puts it and the browser on one private network, under the alias', async () => {
    const f = fakeOps();
    const m = new SandboxManager(f.ops, { browserContainer: BROWSER });
    const r = await m.preview('proj-1');
    assert.equal(r.host, previewHost('proj-1'));
    const net = f.networks.get(r.network)!;
    assert.ok(net, 'network created');
    assert.equal(net.ownerId, 'proj-1');
    assert.deepEqual([...net.attached.keys()].sort(), ['c1', BROWSER].sort());
    assert.deepEqual(net.attached.get('c1'), [r.host]);
    await m.shutdown();
  });

  it('is idempotent', async () => {
    const f = fakeOps();
    const m = new SandboxManager(f.ops, { browserContainer: BROWSER });
    const a = await m.preview('p');
    const b = await m.preview('p');
    assert.deepEqual(a, b);
    assert.equal(f.networks.size, 1);
    assert.equal(f.calls.filter(c => c.startsWith('create:')).length, 1);
    await m.shutdown();
  });

  it('different owners get different networks and hosts', async () => {
    const f = fakeOps();
    const m = new SandboxManager(f.ops, { browserContainer: BROWSER });
    const a = await m.preview('a');
    const b = await m.preview('b');
    assert.notEqual(a.host, b.host);
    assert.notEqual(a.network, b.network);
    assert.equal(f.networks.get(a.network)!.attached.has('c2'), false, 'b is not on a\'s network');
    await m.shutdown();
  });

  it('501 when no browser container is configured', async () => {
    const m = new SandboxManager(fakeOps().ops);
    await assert.rejects(m.preview('p'), (e: Error & { status?: number }) => e.status === 501);
    await m.shutdown();
  });

  it('502 and no leftover network when the browser cannot be attached', async () => {
    const f = fakeOps();
    const m = new SandboxManager(f.ops, { browserContainer: 'missing-browser' });
    await assert.rejects(m.preview('p'), (e: Error & { status?: number }) => e.status === 502 && /browser/.test(e.message));
    assert.equal(f.networks.size, 0);
    await m.shutdown();
  });

  it('the link is cut when the sandbox stops, is destroyed, and for stale networks at adopt()', async () => {
    const f = fakeOps();
    const m = new SandboxManager(f.ops, { browserContainer: BROWSER });
    await m.preview('a');
    await m.stop('a');
    assert.equal(f.networks.size, 0);

    await m.preview('a'); // restarts the same container and re-links
    assert.equal(f.networks.size, 1);
    await m.destroy('a');
    assert.equal(f.networks.size, 0);

    await f.ops.ensurePreviewNetwork('ea-preview-stale', 'x');
    await new SandboxManager(f.ops, { browserContainer: BROWSER }).adopt();
    assert.equal(f.networks.size, 0);
    await m.shutdown();
  });

  it('unpreview without a link is a no-op', async () => {
    const m = new SandboxManager(fakeOps().ops, { browserContainer: BROWSER });
    await m.unpreview('nothing');
    await m.shutdown();
  });
});

describe('preview HTTP API', () => {
  let server: Server;
  let base: string;
  let mgr: SandboxManager;
  before(() => {
    mgr = new SandboxManager(fakeOps().ops, { browserContainer: BROWSER });
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

  it('POST /preview then /unpreview', async () => {
    const r = await post('/preview', { ownerId: 'proj1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.host, previewHost('proj1'));
    assert.equal((await post('/unpreview', { ownerId: 'proj1' })).status, 200);
  });

  it('validates the owner', async () => {
    assert.equal((await post('/preview', {})).status, 400);
    assert.equal((await post('/preview', { ownerId: '../x' })).status, 400);
    assert.equal((await post('/unpreview', {})).status, 400);
  });
});
