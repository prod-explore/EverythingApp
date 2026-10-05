import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SandboxManager, volumeName } from '../sandboxes.js';
import { fakeOps } from './helpers.js';

describe('SandboxManager', () => {
  it('claim is sticky per owner and creates the volume first', async () => {
    const { ops, calls, volumes } = fakeOps();
    const m = new SandboxManager(ops);
    const a = await m.claim('proj-1');
    const b = await m.claim('proj-1');
    assert.equal(a.isNew, true);
    assert.equal(b.isNew, false);
    assert.equal(a.containerId, b.containerId);
    assert.equal(a.workspacePath, '/workspace');
    assert.deepEqual(calls, [`volume:${volumeName('proj-1')}`, 'create:proj-1']);
    assert.ok(volumes.has('everything-workspace-proj-1'));
    await m.shutdown();
  });

  it('concurrent first claims create exactly one container', async () => {
    const { ops, calls } = fakeOps();
    const m = new SandboxManager(ops);
    const [x, y, z] = await Promise.all([m.claim('p'), m.claim('p'), m.claim('p')]);
    assert.equal(new Set([x.containerId, y.containerId, z.containerId]).size, 1);
    assert.equal(calls.filter(c => c.startsWith('create')).length, 1);
    await m.shutdown();
  });

  it('rejects owner ids that are not plain identifiers', async () => {
    const m = new SandboxManager(fakeOps().ops);
    for (const bad of ['', '../x', 'a b', 'a/b', 'x'.repeat(65)]) await assert.rejects(m.claim(bad), /Invalid owner id/);
  });

  it('idle sandbox is stopped (never removed), and the next claim restarts the SAME container', async () => {
    let now = 0;
    const { ops, calls, containers } = fakeOps();
    const m = new SandboxManager(ops, { idleMs: 60_000, now: () => now });
    const first = await m.claim('p');
    now = 120_000;
    const swept = await m.sweep();
    assert.deepEqual(swept.sandboxesStopped, ['p']);
    assert.equal(containers.get(first.containerId)!.running, false);
    assert.ok(!calls.some(c => c.startsWith('remove')), 'no container removal exists in DockerOps at all');

    const again = await m.claim('p');
    assert.equal(again.containerId, first.containerId);
    assert.equal(again.isNew, false);
    assert.equal(containers.get(first.containerId)!.running, true);
    await m.shutdown();
  });

  it('recreates the container around the existing volume if the old one vanished', async () => {
    const { ops, calls, containers } = fakeOps();
    const m = new SandboxManager(ops, { idleMs: 1, now: (() => { let t = 0; return () => (t += 1000); })() });
    const first = await m.claim('p');
    await m.sweep();
    containers.delete(first.containerId); // someone ran `docker rm`
    const again = await m.claim('p');
    assert.notEqual(again.containerId, first.containerId);
    assert.equal(again.isNew, false, 'same sandbox, new container');
    assert.equal(calls.filter(c => c === `volume:${volumeName('p')}`).length, 2, 'volume ensured again, not recreated empty');
    await m.shutdown();
  });

  it('adopts existing containers after a supervisor restart', async () => {
    const { ops, containers } = fakeOps();
    const before = new SandboxManager(ops);
    const c = await before.claim('proj');
    await before.shutdown();

    const after = new SandboxManager(ops);
    assert.equal(await after.adopt(), 1);
    assert.equal(after.status().sandboxes[0]!.running, true);
    const claimed = await after.claim('proj');
    assert.equal(claimed.containerId, c.containerId);
    assert.equal(containers.size, 1);
    await after.shutdown();
  });

  it('at the running limit, claiming a new owner stops the least recently used idle one', async () => {
    let now = 0;
    const { ops, containers } = fakeOps();
    const m = new SandboxManager(ops, { maxRunning: 2, now: () => now });
    const a = await m.claim('a');
    now = 10;
    const b = await m.claim('b');
    now = 20;
    await m.claim('a'); // a is now more recent than b
    now = 30;
    await m.claim('c');
    assert.equal(containers.get(b.containerId)!.running, false, 'LRU (b) stopped');
    assert.equal(containers.get(a.containerId)!.running, true);
    assert.equal(m.status().running, 2);
    await m.shutdown();
  });

  it('never stops a sandbox that is running a command; fails clearly instead', async () => {
    const { ops } = fakeOps();
    const m = new SandboxManager(ops, { maxRunning: 1 });
    const busy = m.run('a', undefined, 'sleep 0.5', 5000);
    await new Promise(r => setTimeout(r, 200));
    await assert.rejects(m.claim('b'), /capacity reached/);
    assert.equal((await busy).exitCode, 0);
    await m.shutdown();
  });

  it('run() uses named terminals that persist state, and logs the command safely', async () => {
    const { ops, logLines } = fakeOps();
    const m = new SandboxManager(ops);
    await m.run('p', 'build', 'cd /tmp && export X=1', 5000);
    const r = await m.run('p', 'build', 'pwd; echo $X', 5000);
    assert.equal(r.output, '/tmp\n1\n');
    assert.equal(r.terminal, 'build');
    const dangerous = 'echo "$(touch /tmp/ea-should-not-exist-log)"';
    await m.run('p', undefined, dangerous, 5000);
    assert.ok(logLines.some(l => l.includes(dangerous)), 'logged verbatim, not expanded');
    assert.deepEqual(m.listTerminals('p').map(t => t.name).sort(), ['build', 'main']);
    assert.equal(await m.closeTerminal('p', 'build'), true);
    await m.shutdown();
  });

  it('stopping a sandbox closes its terminals; files-volume untouched', async () => {
    const { ops, volumes } = fakeOps();
    const m = new SandboxManager(ops);
    await m.run('p', undefined, 'true', 5000);
    assert.equal(m.listTerminals('p').length, 1);
    assert.equal(await m.stop('p'), true);
    assert.equal(m.listTerminals('p').length, 0);
    assert.ok(volumes.has(volumeName('p')));
    assert.equal(await m.stop('p'), false);
    await m.shutdown();
  });

  it('one-shot exec only works against running sandboxes', async () => {
    const m = new SandboxManager(fakeOps().ops);
    const { containerId } = await m.claim('p');
    assert.equal((await m.exec(containerId, 'true', 1000)).exitCode, 0);
    await m.stop('p');
    await assert.rejects(m.exec(containerId, 'true', 1000), /Unknown or stopped/);
    await assert.rejects(m.exec('nope', 'true', 1000), /Unknown or stopped/);
  });
});
