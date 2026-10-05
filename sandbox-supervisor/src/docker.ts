import Docker from 'dockerode';
import { PassThrough, type Duplex } from 'node:stream';
import type { DockerOps, ExecResult, SandboxSpec } from './sandboxes.js';
import type { ShellFactory, ShellProcess } from './terminals.js';

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
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DockerConfig {
  return {
    image: env['SANDBOX_IMAGE'] ?? 'everything-sandbox:latest',
    network: env['SANDBOX_NETWORK'] ?? 'ea-sandbox-egress',
    bridgeName: env['SANDBOX_BRIDGE_NAME'] ?? 'br-ea-sandbox',
    memoryMb: parseInt(env['SANDBOX_MEMORY_MB'] ?? '1024', 10),
    cpus: parseFloat(env['SANDBOX_CPUS'] ?? '2'),
    pidsLimit: parseInt(env['SANDBOX_PIDS_LIMIT'] ?? '512', 10),
    runtime: env['SANDBOX_RUNTIME'] ?? '',
  };
}

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

  async ensureVolume(volume: string, ownerId: string): Promise<void> {
    try {
      await this.docker.getVolume(volume).inspect();
    } catch {
      await this.docker.createVolume({ Name: volume, Labels: { [LABEL]: '1', [OWNER_LABEL]: ownerId } });
    }
  }

  async createContainer(spec: SandboxSpec): Promise<string> {
    const container = await this.docker.createContainer({
      Image: this.cfg.image,
      name: spec.name,
      Labels: { [LABEL]: '1', [OWNER_LABEL]: spec.ownerId },
      WorkingDir: '/workspace',
      Tty: false,
      HostConfig: {
        Binds: [`${spec.volume}:/workspace`],
        NetworkMode: this.cfg.network,
        // Standard Docker hardening, nothing exotic: resource caps, no swap, a pid cap against fork bombs,
        // and Docker's default capability set minus the ones a coding agent has no use for.
        Memory: this.cfg.memoryMb * 1024 * 1024,
        MemorySwap: this.cfg.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(this.cfg.cpus * 1e9),
        PidsLimit: this.cfg.pidsLimit,
        CapDrop: ['NET_RAW', 'MKNOD', 'AUDIT_WRITE', 'SETFCAP'],
        SecurityOpt: ['no-new-privileges:true'],
        RestartPolicy: { Name: 'no' },
        ...(this.cfg.runtime ? { Runtime: this.cfg.runtime } : {}),
      },
    });
    await container.start();
    return container.id;
  }

  async startContainer(id: string): Promise<void> {
    await this.docker.getContainer(id).start();
  }

  async stopContainer(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).stop({ t: 5 });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 304) throw err; // 304 = already stopped
    }
  }

  async listManaged(): Promise<Array<{ id: string; ownerId: string; running: boolean }>> {
    const list = await this.docker.listContainers({ all: true, filters: { label: [`${LABEL}=1`] } });
    return list.map(c => ({ id: c.Id, ownerId: c.Labels[OWNER_LABEL] ?? '', running: c.State === 'running' }));
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
