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
    assert.ok(!calls.some(c => c.startsWith('remove')), 'idling stops, it never removes');

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

const DAY = 24 * 3600_000;

describe('container GC and project deletion', () => {
  it('removes containers stopped for longer than the TTL, keeps the volume, and the next claim rebuilds around it', async () => {
    let now = 0;
    const { ops, calls, containers, volumes } = fakeOps();
    const m = new SandboxManager(ops, { idleMs: 60_000, containerTtlMs: 7 * DAY, now: () => now });
    const first = await m.claim('p');
    assert.equal(first.isNew, true, 'brand-new volume');
    now = 120_000;
    await m.sweep(); // stopped (idle)
    now += 6 * DAY;
    assert.deepEqual((await m.sweep()).containersRemoved, [], 'not yet');
    now += 2 * DAY;
    assert.deepEqual((await m.sweep()).containersRemoved, ['p']);
    assert.equal(containers.has(first.containerId), false);
    assert.ok(volumes.has(volumeName('p')), 'workspace volume kept');
    assert.ok(!calls.some(c => c.startsWith('removeVolume')));
    assert.equal(m.sandboxStatus('p'), null);

    const again = await m.claim('p');
    assert.notEqual(again.containerId, first.containerId);
    assert.equal(again.isNew, false, 'same workspace, new container');
    await m.shutdown();
  });

  it('never garbage-collects a running sandbox', async () => {
    let now = 0;
    const { ops } = fakeOps();
    const m = new SandboxManager(ops, { idleMs: 365 * DAY, containerTtlMs: DAY, now: () => now });
    await m.claim('p');
    now = 30 * DAY;
    assert.deepEqual((await m.sweep()).containersRemoved, []);
    await m.shutdown();
  });

  it('adopted stopped containers keep their real stop time for GC', async () => {
    const now = 100 * DAY;
    const { ops } = fakeOps();
    const listManaged = async () => [{ id: 'old', ownerId: 'p', running: false, stoppedAt: now - 10 * DAY }];
    const m = new SandboxManager({ ...ops, listManaged, removeContainer: async () => true }, { containerTtlMs: 7 * DAY, now: () => now });
    await m.adopt();
    assert.deepEqual((await m.sweep()).containersRemoved, ['p']);
  });

  it('destroy removes container(s) and the volume; it is the only path that deletes a volume', async () => {
    const { ops, containers, volumes } = fakeOps();
    const m = new SandboxManager(ops);
    await m.run('p', undefined, 'true', 5000);
    const r = await m.destroy('p');
    assert.deepEqual(r, { containersRemoved: 1, volumeRemoved: true });
    assert.equal(containers.size, 0);
    assert.equal(volumes.has(volumeName('p')), false);
    assert.equal(m.listTerminals('p').length, 0);
    assert.deepEqual(await m.destroy('p'), { containersRemoved: 0, volumeRemoved: false }, 'idempotent');
    await assert.rejects(m.destroy('../x'), /Invalid owner/);
  });
});

describe('explorer through the manager', () => {
  it('no container and no volume → empty listing, nothing created', async () => {
    const { ops, calls } = fakeOps();
    const m = new SandboxManager(ops);
    const l = await m.listFiles('fresh', '/workspace');
    assert.equal(l.empty, true);
    assert.deepEqual(calls, []);
  });

  it('a stopped sandbox is browsed through the archive API without being started', async () => {
    const { ops, calls, volumes } = fakeOps();
    const m = new SandboxManager(ops);
    await m.claim('p');
    volumes.get(volumeName('p'))!.file('/workspace/src/a.ts', 'const a = 1;');
    await m.stop('p');
    const l = await m.listFiles('p', '/workspace');
    assert.deepEqual(l.entries.map(e => e.name), ['src']);
    assert.ok(calls.includes('archive:/workspace'));
    const f = await m.readFile('p', 'src/a.ts');
    assert.equal(f.data.toString(), 'const a = 1;');
    assert.equal(m.status().running, 0, 'browsing never starts the sandbox');
  });

  it('a running sandbox is listed with find inside the container (no archive)', async () => {
    const { ops, calls, execCommands } = fakeOps();
    const m = new SandboxManager(ops);
    await m.claim('p');
    await m.listFiles('p', '/workspace');
    assert.ok(execCommands.some(c => c.includes('find "$p" -mindepth 1 -maxdepth 1')));
    assert.ok(!calls.some(c => c.startsWith('archive:')));
  });

  it('after container GC, browsing creates a STOPPED container around the kept volume', async () => {
    let now = 0;
    const { ops, calls, volumes } = fakeOps();
    const m = new SandboxManager(ops, { idleMs: 1, containerTtlMs: DAY, now: () => now });
    await m.claim('p');
    volumes.get(volumeName('p'))!.file('/workspace/keep.txt', 'still here');
    now = 10;
    await m.sweep();
    now = 2 * DAY;
    await m.sweep();
    assert.equal(m.sandboxStatus('p'), null);
    const l = await m.listFiles('p', '/workspace');
    assert.deepEqual(l.entries.map(e => e.name), ['keep.txt']);
    assert.ok(calls.includes('createStopped:p'));
    assert.equal(m.sandboxStatus('p')!.running, false);
    // and a later claim just starts that container
    const c = await m.claim('p');
    assert.equal(c.isNew, false);
    assert.equal(m.sandboxStatus('p')!.containerId, c.containerId);
    await m.shutdown();
  });
});

describe('CPU watchdog', () => {
  const MIN = 60_000;
  const setup = () => {
    let now = 0;
    const f = fakeOps();
    const m = new SandboxManager(f.ops, {
      now: () => now,
      idleMs: 365 * DAY,
      cpu: { thresholdPercent: 90, samples: 3, stopAfterSamples: 2, agentIdleMs: 10 * MIN },
    });
    return { m, f, advance: (ms: number) => (now += ms) };
  };

  it('hot + agent idle → warning event (in /health status), then stop if it continues', async () => {
    const { m, f, advance } = setup();
    const { containerId } = await m.claim('p');
    f.cpu.set(containerId, 99);
    advance(11 * MIN);
    assert.deepEqual(await m.sampleCpu(), { warned: [], stopped: [] });
    assert.deepEqual(await m.sampleCpu(), { warned: [], stopped: [] });
    assert.deepEqual(await m.sampleCpu(), { warned: ['p'], stopped: [] }, 'third consecutive hot sample');
    const st = m.sandboxStatus('p')!;
    assert.equal(st.warnings.length, 1);
    assert.equal(st.warnings[0]!.type, 'cpu_high');
    assert.equal(st.cpuHot, true);
    assert.equal(m.status().warnings[0]!.ownerId, 'p');
    assert.deepEqual(await m.sampleCpu(), { warned: [], stopped: [] });
    assert.deepEqual(await m.sampleCpu(), { warned: [], stopped: ['p'] });
    assert.equal(f.containers.get(containerId)!.running, false);
    assert.deepEqual(m.sandboxStatus('p')!.warnings.map(w => w.type), ['cpu_high', 'cpu_stopped']);
    await m.shutdown();
  });

  it('does nothing while the agent is active (recent exec or a running command)', async () => {
    const { m, f, advance } = setup();
    const { containerId } = await m.claim('p');
    f.cpu.set(containerId, 100);
    advance(5 * MIN); // agent idle only 5m
    for (let i = 0; i < 6; i++) assert.deepEqual(await m.sampleCpu(), { warned: [], stopped: [] });
    advance(20 * MIN);
    await m.exec(containerId, 'true', 1000); // agent activity resets the clock
    for (let i = 0; i < 6; i++) assert.deepEqual(await m.sampleCpu(), { warned: [], stopped: [] });
    // A long-running terminal command counts as activity too.
    const busy = m.run('p', 'build', 'sleep 0.6', 5000);
    await new Promise(r => setTimeout(r, 200));
    advance(30 * MIN);
    for (let i = 0; i < 6; i++) assert.deepEqual(await m.sampleCpu(), { warned: [], stopped: [] });
    await busy;
    assert.equal(m.sandboxStatus('p')!.warnings.length, 0);
    await m.shutdown();
  });

  it('a cool sample resets the streak', async () => {
    const { m, f, advance } = setup();
    const { containerId } = await m.claim('p');
    advance(11 * MIN);
    for (const pct of [95, 95, 10, 95, 95]) {
      f.cpu.set(containerId, pct);
      assert.deepEqual(await m.sampleCpu(), { warned: [], stopped: [] }, `at ${pct}`);
    }
    assert.equal(m.sandboxStatus('p')!.cpuPercent, 95);
    await m.shutdown();
  });

  it('stats errors are ignored; stopped sandboxes are not sampled', async () => {
    let sampled = 0;
    const f = fakeOps({
      cpuPercent: async () => {
        sampled++;
        throw new Error('stats unavailable');
      },
    });
    const m = new SandboxManager(f.ops);
    await m.claim('a');
    await m.claim('b');
    await m.stop('b');
    assert.deepEqual(await m.sampleCpu(), { warned: [], stopped: [] });
    assert.equal(sampled, 1);
    await m.shutdown();
  });
});
