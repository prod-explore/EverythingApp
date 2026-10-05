import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Docker from 'dockerode';
import { DockerodeOps, buildCreateOptions, configFromEnv, cpuPercentFromStats } from '../docker.js';

const spec = { ownerId: 'proj-1', volume: 'everything-workspace-proj-1', name: 'everything-sandbox-proj-1-x' };

describe('container hardening', () => {
  it('defaults: 1 CPU, 512 MB, 256 pids, non-root, read-only rootfs', () => {
    const cfg = configFromEnv({});
    assert.equal(cfg.cpus, 1);
    assert.equal(cfg.memoryMb, 512);
    assert.equal(cfg.pidsLimit, 256);
    assert.equal(cfg.user, '1000:1000');
    assert.equal(cfg.readonlyRootfs, true);
    assert.equal(cfg.runtime, '');
  });

  it('create options are locked down', () => {
    const o = buildCreateOptions(configFromEnv({}), spec);
    const h = o.HostConfig!;
    assert.equal(o.User, '1000:1000');
    assert.deepEqual(h.CapDrop, ['ALL']);
    assert.equal(h.CapAdd, undefined);
    assert.deepEqual(h.SecurityOpt, ['no-new-privileges']);
    assert.ok(!h.SecurityOpt!.some(s => s.startsWith('seccomp')), 'default seccomp profile is never overridden');
    assert.equal(h.Privileged, false);
    assert.equal(h.ReadonlyRootfs, true);
    assert.equal(h.NanoCpus, 1e9);
    assert.equal(h.Memory, 512 * 1024 * 1024);
    assert.equal(h.MemorySwap, 512 * 1024 * 1024, 'no swap on top of the memory cap');
    assert.equal(h.PidsLimit, 256);
    assert.equal(h.NetworkMode, 'ea-sandbox-egress');
    assert.deepEqual(h.RestartPolicy, { Name: 'no' });
    assert.equal(h.Runtime, undefined);
    // Only writable places: the workspace volume and tmpfs mounts.
    assert.deepEqual(h.Binds, ['everything-workspace-proj-1:/workspace']);
    assert.deepEqual(Object.keys(h.Tmpfs!).sort(), ['/home/sandbox', '/run', '/tmp']);
    assert.match(h.Tmpfs!['/home/sandbox']!, /uid=1000,gid=1000/);
    assert.ok(o.Env!.includes('HOME=/home/sandbox'));
    assert.equal(h.Mounts, undefined);
    assert.equal(h.Devices, undefined);
    assert.ok(!JSON.stringify(o).includes('docker.sock'), 'docker socket is never mounted');
    assert.deepEqual(o.Labels, { 'everythingapp.sandbox': '1', 'everythingapp.owner': 'proj-1' });
  });

  it('is configurable from env, including an OCI runtime', () => {
    const cfg = configFromEnv({
      SANDBOX_CPUS: '1.5',
      SANDBOX_MEMORY_MB: '768',
      SANDBOX_PIDS_LIMIT: '128',
      SANDBOX_RUNTIME: 'runsc',
      SANDBOX_NETWORK: 'iso-net',
      SANDBOX_USER: '2000:3000',
      SANDBOX_HOME: '/home/agent',
    });
    const h = buildCreateOptions(cfg, spec).HostConfig!;
    assert.equal(h.NanoCpus, 1.5e9);
    assert.equal(h.Memory, 768 * 1024 * 1024);
    assert.equal(h.PidsLimit, 128);
    assert.equal(h.Runtime, 'runsc');
    assert.equal(h.NetworkMode, 'iso-net');
    assert.match(h.Tmpfs!['/home/agent']!, /uid=2000,gid=3000/);
  });

  it('garbage env values fall back to the defaults', () => {
    const cfg = configFromEnv({ SANDBOX_CPUS: 'lots', SANDBOX_MEMORY_MB: '-5', SANDBOX_PIDS_LIMIT: '' });
    assert.equal(cfg.cpus, 1);
    assert.equal(cfg.memoryMb, 512);
    assert.equal(cfg.pidsLimit, 256);
  });

  it('DockerodeOps passes exactly these options to Docker, and can create without starting', async () => {
    const created: Docker.ContainerCreateOptions[] = [];
    let started = 0;
    const docker = {
      createContainer: async (o: Docker.ContainerCreateOptions) => {
        created.push(o);
        return { id: 'abc', start: async () => void started++ };
      },
    } as unknown as Docker;
    const ops = new DockerodeOps(configFromEnv({}), docker);
    assert.equal(await ops.createContainer(spec), 'abc');
    assert.equal(started, 1);
    await ops.createContainer(spec, { start: false });
    assert.equal(started, 1);
    assert.deepEqual(created[0], buildCreateOptions(configFromEnv({}), spec));
  });
});

describe('DockerodeOps helpers', () => {
  const err404 = () => Object.assign(new Error('not found'), { statusCode: 404 });

  it('statPath decodes the archive stat header; 404 → null', async () => {
    const stat = { name: 'a.txt', size: 3, mode: 420, mtime: '2026-01-01T00:00:00Z', linkTarget: '' };
    const docker = {
      getContainer: (id: string) => ({
        infoArchive: async () => {
          if (id === 'gone') throw err404();
          return { headers: { 'x-docker-container-path-stat': Buffer.from(JSON.stringify(stat)).toString('base64') }, resume() {} };
        },
      }),
    } as unknown as Docker;
    const ops = new DockerodeOps(configFromEnv({}), docker);
    assert.deepEqual(await ops.statPath('c', '/workspace/a.txt'), stat);
    assert.equal(await ops.statPath('gone', '/workspace/a.txt'), null);
  });

  it('removeContainer / removeVolume treat 404 as "already gone" and never remove volumes with the container', async () => {
    const removed: unknown[] = [];
    const docker = {
      getContainer: (id: string) => ({
        remove: async (o: unknown) => {
          if (id === 'gone') throw err404();
          removed.push(o);
        },
      }),
      getVolume: (name: string) => ({
        remove: async () => {
          if (name === 'gone') throw err404();
        },
      }),
    } as unknown as Docker;
    const ops = new DockerodeOps(configFromEnv({}), docker);
    assert.equal(await ops.removeContainer('c1'), true);
    assert.deepEqual(removed, [{ force: true, v: false }]);
    assert.equal(await ops.removeContainer('gone'), false);
    assert.equal(await ops.removeVolume('v'), true);
    assert.equal(await ops.removeVolume('gone'), false);
  });

  it('cpu percent is normalised to the CPU limit', () => {
    const stats = (total: number, sys: number, preTotal: number, preSys: number) =>
      ({
        cpu_stats: { cpu_usage: { total_usage: total }, system_cpu_usage: sys, online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: preTotal }, system_cpu_usage: preSys, online_cpus: 4 },
      }) as unknown as Docker.ContainerStats;
    // One full core out of 4 host cores: 25% of system time → 100% of a 1-CPU limit.
    assert.equal(Math.round(cpuPercentFromStats(stats(1250, 5000, 1000, 4000), 1)), 100);
    assert.equal(Math.round(cpuPercentFromStats(stats(1250, 5000, 1000, 4000), 2)), 50);
    assert.equal(cpuPercentFromStats(stats(1000, 5000, 1000, 4000), 1), 0);
    assert.equal(cpuPercentFromStats(stats(1000, 4000, 1000, 4000), 1), 0, 'no system delta → 0, not NaN');
  });
});
