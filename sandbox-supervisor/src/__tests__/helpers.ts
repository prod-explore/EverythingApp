import { spawn } from 'node:child_process';
import type { ShellFactory, ShellProcess } from '../terminals.js';
import type { DockerOps, SandboxSpec } from '../sandboxes.js';

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
      try {
        process.kill(-proc.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    },
  };
  return shell;
};

/** In-memory Docker. Containers are just records; shells are real local bash processes. */
export function fakeOps(over: Partial<DockerOps> = {}) {
  const calls: string[] = [];
  const containers = new Map<string, { spec: SandboxSpec; running: boolean }>();
  const volumes = new Set<string>();
  const logLines: string[] = [];
  let n = 0;
  const ops: DockerOps = {
    async ensureVolume(v) {
      calls.push(`volume:${v}`);
      volumes.add(v);
    },
    async createContainer(spec) {
      const id = `c${++n}`;
      containers.set(id, { spec, running: true });
      calls.push(`create:${spec.ownerId}`);
      return id;
    },
    async startContainer(id) {
      const c = containers.get(id);
      if (!c) throw new Error('No such container');
      c.running = true;
      calls.push(`start:${id}`);
    },
    async stopContainer(id) {
      containers.get(id)!.running = false;
      calls.push(`stop:${id}`);
    },
    async listManaged() {
      return [...containers].map(([id, c]) => ({ id, ownerId: c.spec.ownerId, running: c.running }));
    },
    async exec(_id, command) {
      // The action-log append: decode what would be written so the test can inspect it.
      const m = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d >>/.exec(command);
      if (m) logLines.push(Buffer.from(m[1]!, 'base64').toString('utf8'));
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    shellFactory: () => localBashFactory,
    ...over,
  };
  return { ops, calls, containers, volumes, logLines };
}

