import Docker from 'dockerode';
import type { IncomingMessage } from 'node:http';
import { PassThrough, type Duplex, type Readable } from 'node:stream';
import type { DockerOps, ExecResult, ManagedContainer, SandboxSpec } from './sandboxes.js';
import type { ShellFactory, ShellProcess } from './terminals.js';
import { WORKSPACE, type PathStat } from './explorer.js';

export const LABEL = 'everythingapp.sandbox';
const OWNER_LABEL = 'everythingapp.owner';

export interface DockerConfig {
  image: string;
  /** Dedicated bridge for sandboxes (created on demand). Isolation between sandboxes: no inter-container traffic. */
  network: string;
  /** Host bridge interface name, so deploy/egress-guard.sh can fence the network off from the LAN. */
  bridgeName: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  /** Optional OCI runtime, e.g. "runsc" for gVisor. Empty = Docker's default. */
  runtime: string;
  /** uid:gid the sandbox runs as. Must match the image's sandbox user (1000:1000). */
  user: string;
  /** HOME inside the sandbox; a tmpfs because the root filesystem is read-only. */
  home: string;
  readonlyRootfs: boolean;
  tmpSizeMb: number;
  homeSizeMb: number;
}

const num = (v: string | undefined, fallback: number, parse = parseInt) => {
  const n = v === undefined || v === '' ? NaN : parse(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DockerConfig {
  return {
    image: env['SANDBOX_IMAGE'] ?? 'everything-sandbox:latest',
    network: env['SANDBOX_NETWORK'] ?? 'ea-sandbox-egress',
    bridgeName: env['SANDBOX_BRIDGE_NAME'] ?? 'br-ea-sandbox',
    memoryMb: num(env['SANDBOX_MEMORY_MB'], 512),
    cpus: num(env['SANDBOX_CPUS'], 1, (s: string) => parseFloat(s)),
    pidsLimit: num(env['SANDBOX_PIDS_LIMIT'], 256),
    runtime: env['SANDBOX_RUNTIME'] ?? '',
    user: env['SANDBOX_USER'] || '1000:1000',
    home: env['SANDBOX_HOME'] || '/home/sandbox',
    readonlyRootfs: env['SANDBOX_READONLY_ROOTFS'] !== 'false',
    tmpSizeMb: num(env['SANDBOX_TMP_MB'], 512),
    homeSizeMb: num(env['SANDBOX_HOME_MB'], 256),
  };
}

/**
 * The container create options — the whole hardening story lives here:
 * - non-root user, ALL capabilities dropped, no-new-privileges, Docker's default seccomp profile (never overridden);
 * - read-only root filesystem: the only persistent writable path is the per-project /workspace volume,
 *   plus tmpfs for /tmp, /run and $HOME (gone when the container stops);
 * - CPU / memory (no extra swap) / pid caps; restart policy "no";
 * - attached only to the isolated sandbox network; no host binds at all (in particular no docker.sock);
 * - optional OCI runtime (SANDBOX_RUNTIME=runsc → gVisor).
 */
export function buildCreateOptions(cfg: DockerConfig, spec: SandboxSpec): Docker.ContainerCreateOptions {
  const [uid = '1000', gid = uid] = cfg.user.split(':');
  const tmpfsOpts = 'rw,nosuid,nodev';
  return {
    Image: cfg.image,
    name: spec.name,
    Labels: { [LABEL]: '1', [OWNER_LABEL]: spec.ownerId },
    User: cfg.user,
    WorkingDir: WORKSPACE,
    Env: [`HOME=${cfg.home}`, 'TMPDIR=/tmp'],
    Tty: false,
    HostConfig: {
      // Named volume only. Never a host path, never /var/run/docker.sock.
      Binds: [`${spec.volume}:${WORKSPACE}`],
      NetworkMode: cfg.network,
      ReadonlyRootfs: cfg.readonlyRootfs,
      Tmpfs: {
        '/tmp': `${tmpfsOpts},mode=1777,size=${cfg.tmpSizeMb}m`,
        '/run': `${tmpfsOpts},noexec,mode=755,size=16m`,
        [cfg.home]: `${tmpfsOpts},mode=700,uid=${uid},gid=${gid},size=${cfg.homeSizeMb}m`,
      },
      Memory: cfg.memoryMb * 1024 * 1024,
      MemorySwap: cfg.memoryMb * 1024 * 1024,
      NanoCpus: Math.round(cfg.cpus * 1e9),
      PidsLimit: cfg.pidsLimit,
      CapDrop: ['ALL'],
      // No seccomp=... entry on purpose: Docker then applies its default seccomp profile.
      SecurityOpt: ['no-new-privileges'],
      Privileged: false,
      RestartPolicy: { Name: 'no' },
      ...(cfg.runtime ? { Runtime: cfg.runtime } : {}),
    },
  };
}

/** Docker-style CPU% (100 = one full core) from a one-shot stats sample, normalised to the container's CPU limit. */
export function cpuPercentFromStats(stats: Docker.ContainerStats, cpuLimit: number): number {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const sysDelta = (stats.cpu_stats.system_cpu_usage ?? 0) - (stats.precpu_stats.system_cpu_usage ?? 0);
  if (cpuDelta <= 0 || sysDelta <= 0) return 0;
  const online = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  const percentOfOneCore = (cpuDelta / sysDelta) * online * 100;
  return percentOfOneCore / (cpuLimit > 0 ? cpuLimit : online);
}

const statusOf = (err: unknown) => (err as { statusCode?: number }).statusCode;

/** Shell snippet that kills a process and all its descendants (needs procps' pgrep in the image). */
function killTreeCommand(pid: number): string {
  return `kt(){ for c in $(pgrep -P "$1" 2>/dev/null); do kt "$c"; done; kill -9 "$1" 2>/dev/null; }; kt ${pid}`;
}

export class DockerodeOps implements DockerOps {
  constructor(
    private readonly cfg: DockerConfig,
    private readonly docker = new Docker(),
  ) {}

  /** The sandbox network: a plain user-defined bridge, with container-to-container traffic switched off. */
  async ensureNetwork(): Promise<void> {
    try {
      await this.docker.getNetwork(this.cfg.network).inspect();
      return;
    } catch {
      /* not there yet */
    }
    await this.docker.createNetwork({
      Name: this.cfg.network,
      Driver: 'bridge',
      Options: {
        'com.docker.network.bridge.name': this.cfg.bridgeName,
        'com.docker.network.bridge.enable_icc': 'false',
      },
      Labels: { [LABEL]: '1' },
    });
    console.log(`[docker] created network ${this.cfg.network} (bridge ${this.cfg.bridgeName})`);
  }

  /** Returns true when the volume had to be created (i.e. the workspace is brand new). */
  async ensureVolume(volume: string, ownerId: string): Promise<boolean> {
    if (await this.volumeExists(volume)) return false;
    await this.docker.createVolume({ Name: volume, Labels: { [LABEL]: '1', [OWNER_LABEL]: ownerId } });
    return true;
  }

  async volumeExists(volume: string): Promise<boolean> {
    try {
      await this.docker.getVolume(volume).inspect();
      return true;
    } catch (err) {
      if (statusOf(err) === 404) return false;
      throw err;
    }
  }

  async removeVolume(volume: string): Promise<boolean> {
    try {
      await this.docker.getVolume(volume).remove();
      return true;
    } catch (err) {
      if (statusOf(err) === 404) return false;
      throw err;
    }
  }

  async createContainer(spec: SandboxSpec, opts: { start?: boolean } = {}): Promise<string> {
    const container = await this.docker.createContainer(buildCreateOptions(this.cfg, spec));
    if (opts.start !== false) await container.start();
    return container.id;
  }

  async startContainer(id: string): Promise<void> {
    await this.docker.getContainer(id).start();
  }

  async stopContainer(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).stop({ t: 5 });
    } catch (err) {
      if (statusOf(err) !== 304) throw err; // 304 = already stopped
    }
  }

  /** Removes the container (never its volume). false if it was already gone. */
  async removeContainer(id: string): Promise<boolean> {
    try {
      await this.docker.getContainer(id).remove({ force: true, v: false });
      return true;
    } catch (err) {
      if (statusOf(err) === 404) return false;
      throw err;
    }
  }

  async listManaged(): Promise<ManagedContainer[]> {
    const list = await this.docker.listContainers({ all: true, filters: { label: [`${LABEL}=1`] } });
    return Promise.all(
      list.map(async c => {
        const running = c.State === 'running';
        let stoppedAt: number | undefined;
        if (!running) {
          // When it stopped matters for container GC across supervisor restarts.
          const info = await this.docker.getContainer(c.Id).inspect().catch(() => undefined);
          const t = info ? Date.parse(info.State.FinishedAt) : NaN;
          stoppedAt = Number.isFinite(t) && t > 0 ? t : undefined;
        }
        return { id: c.Id, ownerId: c.Labels[OWNER_LABEL] ?? '', running, stoppedAt };
      }),
    );
  }

  async cpuPercent(id: string): Promise<number> {
    const stats = (await this.docker.getContainer(id).stats({ stream: false })) as Docker.ContainerStats;
    return cpuPercentFromStats(stats, this.cfg.cpus);
  }

  async statPath(id: string, path: string): Promise<PathStat | null> {
    try {
      const res = (await this.docker.getContainer(id).infoArchive({ path })) as IncomingMessage;
      res.resume();
      const header = res.headers['x-docker-container-path-stat'];
      if (typeof header !== 'string') return null;
      return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PathStat;
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
  }

  async getArchive(id: string, path: string): Promise<Readable> {
    return (await this.docker.getContainer(id).getArchive({ path })) as unknown as Readable;
  }

  /** One-shot `bash -c` in the container, output captured. Used for git_op, read_log and the action log. */
  exec(id: string, command: string, timeoutMs: number): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const container = this.docker.getContainer(id);
      container
        .exec({ Cmd: ['bash', '-c', command], AttachStdout: true, AttachStderr: true, WorkingDir: '/workspace' })
        .then(exec => {
          const timer = setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)), timeoutMs);
          exec.start({ hijack: true, stdin: false }, (err, stream) => {
            if (err || !stream) {
              clearTimeout(timer);
              reject(err ?? new Error('No stream returned from exec'));
              return;
            }
            const out = new PassThrough();
            const errOut = new PassThrough();
            this.docker.modem.demuxStream(stream, out, errOut);
            const so: Buffer[] = [];
            const se: Buffer[] = [];
            out.on('data', (c: Buffer) => so.push(c));
            errOut.on('data', (c: Buffer) => se.push(c));
            stream.on('error', e => {
              clearTimeout(timer);
              reject(e);
            });
            stream.on('end', () => {
              clearTimeout(timer);
              exec.inspect((e, data) =>
                resolve({
                  stdout: Buffer.concat(so).toString('utf8'),
                  stderr: Buffer.concat(se).toString('utf8'),
                  exitCode: e || !data ? -1 : (data.ExitCode ?? -1),
                }),
              );
            });
          });
        })
        .catch(reject);
    });
  }

  /** A persistent interactive-ish bash via `docker exec` with stdin attached. */
  shellFactory(id: string): ShellFactory {
    return async () => {
      const container = this.docker.getContainer(id);
      const exec = await container.exec({
        // First line is the shell's pid (needed to kill the tree later); `nice` keeps a runaway build from starving the Pi.
        Cmd: ['bash', '-c', 'echo $$; exec nice -n 10 bash --noprofile --norc'],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        WorkingDir: '/workspace',
      });
      const stream = (await exec.start({ hijack: true, stdin: true })) as Duplex;

      const out = new PassThrough();
      const err = new PassThrough();
      this.docker.modem.demuxStream(stream, out, err);

      const dataCbs: Array<(c: string) => void> = [];
      const exitCbs: Array<() => void> = [];
      let pid: number | null = null;
      let pidBuf = '';
      const emit = (text: string) => {
        if (pid === null) {
          pidBuf += text;
          const nl = pidBuf.indexOf('\n');
          if (nl === -1) return;
          pid = parseInt(pidBuf.slice(0, nl), 10) || null;
          text = pidBuf.slice(nl + 1);
          pidBuf = '';
          if (!text) return;
        }
        dataCbs.forEach(cb => cb(text));
      };
      out.on('data', (b: Buffer) => emit(b.toString('utf8')));
      err.on('data', (b: Buffer) => emit(b.toString('utf8')));
      let exited = false;
      const onEnd = () => {
        if (exited) return;
        exited = true;
        exitCbs.forEach(cb => cb());
      };
      stream.on('end', onEnd);
      stream.on('close', onEnd);
      stream.on('error', onEnd);

      const shell: ShellProcess = {
        write: d => void stream.write(d),
        onData: cb => void dataCbs.push(cb),
        onExit: cb => void exitCbs.push(cb),
        kill: async () => {
          if (pid !== null) await this.exec(id, killTreeCommand(pid), 5_000).catch(() => undefined);
          stream.end();
          onEnd();
        },
      };
      return shell;
    };
  }
}
