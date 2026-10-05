import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';
import tar from 'tar-stream';
import type { ShellFactory, ShellProcess } from '../terminals.js';
import type { DockerOps, ExecResult, SandboxSpec } from '../sandboxes.js';
import type { PathStat } from '../explorer.js';

/** A real local bash, standing in for `docker exec bash`: merged output, kills its whole process group. */
export const localBashFactory: ShellFactory = async () => {
  const proc = spawn('bash', ['--noprofile', '--norc'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const dataCbs: Array<(c: string) => void> = [];
  const exitCbs: Array<() => void> = [];
  proc.stdout.on('data', (b: Buffer) => dataCbs.forEach(cb => cb(b.toString('utf8'))));
  proc.stderr.on('data', (b: Buffer) => dataCbs.forEach(cb => cb(b.toString('utf8'))));
  proc.on('exit', () => exitCbs.forEach(cb => cb()));
  proc.stdin.on('error', () => {}); // writing to a dead shell must not crash the test run
  const shell: ShellProcess = {
    write: d => void proc.stdin.write(d),
    onData: cb => void dataCbs.push(cb),
    onExit: cb => void exitCbs.push(cb),
    async kill() {
      // POSIX: kill the whole process group. Windows (Git Bash) has no process groups for node: `process.kill(-pid)`
      // throws, the shell survived, and its open pipes kept the test process alive until the file-level timeout
      // cancelled the whole file. Use taskkill /T there. Either way drop our end of the pipes.
      if (process.platform === 'win32') {
        if (proc.exitCode === null) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try {
          process.kill(-proc.pid!, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      proc.stdin.destroy();
      proc.stdout.destroy();
      proc.stderr.destroy();
      proc.unref();
    },
  };
  return shell;
};

/** Run a one-shot command with the local bash (stands in for `docker exec bash -c`). */
export function localExec(command: string, timeoutMs = 15_000): ExecResult {
  const r = spawnSync('bash', ['-c', command], { encoding: 'utf8', timeout: timeoutMs });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? -1 };
}

export interface FakeNode {
  type: 'file' | 'directory' | 'symlink';
  content?: Buffer;
  target?: string;
  mtime?: Date;
}

/** An in-memory filesystem standing in for a workspace volume. Paths are absolute (/workspace/...). */
export class FakeFs {
  readonly nodes = new Map<string, FakeNode>([['/workspace', { type: 'directory' }]]);

  private ensureParents(p: string): void {
    const parent = path.posix.dirname(p);
    if (parent === '/' || this.nodes.has(parent)) return;
    this.ensureParents(parent);
    this.nodes.set(parent, { type: 'directory' });
  }

  file(p: string, content: string | Buffer): this {
    this.ensureParents(p);
    this.nodes.set(p, { type: 'file', content: Buffer.isBuffer(content) ? content : Buffer.from(content), mtime: new Date('2026-01-02T03:04:05Z') });
    return this;
  }

  dir(p: string): this {
    this.ensureParents(p);
    this.nodes.set(p, { type: 'directory' });
    return this;
  }

  symlink(p: string, target: string): this {
    this.ensureParents(p);
    this.nodes.set(p, { type: 'symlink', target });
    return this;
  }

  stat(p: string): PathStat | null {
    const n = this.nodes.get(p);
    if (!n) return null;
    const mode = n.type === 'directory' ? 2 ** 31 + 0o755 : n.type === 'symlink' ? 2 ** 27 + 0o777 : 0o644;
    return { name: path.posix.basename(p), size: n.content?.length ?? 0, mode, mtime: (n.mtime ?? new Date()).toISOString(), linkTarget: n.target ?? '' };
  }

  /** A real tar stream, laid out like Docker's archive API: entries are `<basename>/...`. */
  archive(p: string): Readable {
    const pack = tar.pack();
    const base = path.posix.basename(p);
    const paths = [...this.nodes.keys()].filter(k => k === p || k.startsWith(`${p}/`)).sort();
    for (const k of paths) {
      const n = this.nodes.get(k)!;
      const name = base + k.slice(p.length);
      if (n.type === 'directory') pack.entry({ name: `${name}/`, type: 'directory', mode: 0o755, mtime: n.mtime });
      else if (n.type === 'symlink') pack.entry({ name, type: 'symlink', linkname: n.target, mode: 0o777 });
      else pack.entry({ name, type: 'file', mode: 0o644, mtime: n.mtime }, n.content ?? Buffer.alloc(0));
    }
    pack.finalize();
    return pack as unknown as Readable;
  }
}

/** In-memory Docker. Containers are just records; shells are real local bash processes; volumes are FakeFs trees. */
export function fakeOps(over: Partial<DockerOps> = {}) {
  const calls: string[] = [];
  const containers = new Map<string, { spec: SandboxSpec; running: boolean }>();
  const volumes = new Map<string, FakeFs>();
  const logLines: string[] = [];
  const execCommands: string[] = [];
  const cpu = new Map<string, number>();
  let n = 0;
  const fsOf = (id: string) => {
    const c = containers.get(id);
    return c ? volumes.get(c.spec.volume) : undefined;
  };
  const ops: DockerOps = {
    async ensureVolume(v) {
      calls.push(`volume:${v}`);
      if (volumes.has(v)) return false;
      volumes.set(v, new FakeFs());
      return true;
    },
    async volumeExists(v) {
      return volumes.has(v);
    },
    async removeVolume(v) {
      calls.push(`removeVolume:${v}`);
      return volumes.delete(v);
    },
    async createContainer(spec, opts) {
      const id = `c${++n}`;
      const start = opts?.start !== false;
      containers.set(id, { spec, running: start });
      calls.push(`${start ? 'create' : 'createStopped'}:${spec.ownerId}`);
      return id;
    },
    async startContainer(id) {
      const c = containers.get(id);
      if (!c) throw new Error('No such container');
      c.running = true;
      calls.push(`start:${id}`);
    },
    async stopContainer(id) {
      const c = containers.get(id);
      if (c) c.running = false;
      calls.push(`stop:${id}`);
    },
    async removeContainer(id) {
      calls.push(`remove:${id}`);
      return containers.delete(id);
    },
    async listManaged() {
      return [...containers].map(([id, c]) => ({ id, ownerId: c.spec.ownerId, running: c.running }));
    },
    async cpuPercent(id) {
      return cpu.get(id) ?? 0;
    },
    async statPath(id, p) {
      calls.push(`stat:${p}`);
      return fsOf(id)?.stat(p) ?? null;
    },
    async getArchive(id, p) {
      calls.push(`archive:${p}`);
      const fs = fsOf(id);
      if (!fs?.nodes.has(p)) throw Object.assign(new Error('Could not find the file'), { statusCode: 404 });
      return fs.archive(p);
    },
    async exec(_id, command) {
      execCommands.push(command);
      // The action-log append: decode what would be written so the test can inspect it.
      const m = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d >>/.exec(command);
      if (m) logLines.push(Buffer.from(m[1]!, 'base64').toString('utf8'));
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    shellFactory: () => localBashFactory,
    ...over,
  };
  return { ops, calls, containers, volumes, logLines, execCommands, cpu };
}
