import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SandboxManager } from '../sandboxes.js';
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
  });
});
