import { TerminalManager, DEFAULT_TERMINAL, type RunResult, type ShellFactory, type TerminalInfo } from './terminals.js';

/**
 * One sandbox per *owner* — a project, or a standalone chat when it has none.
 *
 * - The workspace is a named Docker volume mounted at /workspace. Nothing in this file ever deletes it:
 *   files, git checkouts and installed project dependencies survive idling, supervisor restarts and reboots.
 * - Idle sandboxes are STOPPED, not removed, so system-level installs (apt, global npm) also survive.
 *   Only terminals (shell sessions) and the running container are reclaimed.
 * - At most `maxRunning` sandboxes run at once (the Pi has 8 GB shared with other services); claiming
 *   a new one stops the least recently used idle sandbox, or fails clearly if every one is busy.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxSpec {
  ownerId: string;
  volume: string;
  name: string;
}

/** Everything the manager needs from Docker. dockerode implements it (docker.ts); tests fake it. */
export interface DockerOps {
  ensureVolume(volume: string, ownerId: string): Promise<void>;
  /** Creates AND starts a container with the volume mounted at /workspace. Returns its id. */
  createContainer(spec: SandboxSpec): Promise<string>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string): Promise<void>;
  /** Every container this supervisor created, running or not (adopted after a supervisor restart). */
  listManaged(): Promise<Array<{ id: string; ownerId: string; running: boolean }>>;
  exec(id: string, command: string, timeoutMs: number): Promise<ExecResult>;
  shellFactory(id: string): ShellFactory;
}

export interface SandboxManagerOptions {
  maxRunning?: number;
  /** A sandbox with no activity for this long is stopped (its volume stays). */
  idleMs?: number;
  terminalIdleMs?: number;
  maxTerminals?: number;
  maxOutputChars?: number;
  now?: () => number;
}

interface Sandbox {
  ownerId: string;
  containerId: string;
  running: boolean;
  lastActivityAt: number;
  terminals: TerminalManager;
}

const OWNER_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const WORKSPACE = '/workspace';
export const ACTION_LOG = '/var/log/sandbox-actions.log';

export function volumeName(ownerId: string): string {
  return `everything-workspace-${ownerId.toLowerCase()}`;
}

export class SandboxManager {
  private readonly sandboxes = new Map<string, Sandbox>();
  private readonly inflight = new Map<string, Promise<{ sandbox: Sandbox; isNew: boolean }>>();
  private watchdog: NodeJS.Timeout | undefined;
  private readonly opts: Required<SandboxManagerOptions>;

  constructor(
    private readonly ops: DockerOps,
    opts: SandboxManagerOptions = {},
  ) {
    this.opts = {
      maxRunning: opts.maxRunning ?? 2,
      idleMs: opts.idleMs ?? 30 * 60_000,
      terminalIdleMs: opts.terminalIdleMs ?? 15 * 60_000,
      maxTerminals: opts.maxTerminals ?? 4,
      maxOutputChars: opts.maxOutputChars ?? 200_000,
      now: opts.now ?? Date.now,
    };
  }

  static validOwner(ownerId: string): boolean {
    return OWNER_RE.test(ownerId);
  }

  /** Re-attach to sandboxes that already exist (supervisor restart). Their shells are gone; their files are not. */
  async adopt(): Promise<number> {
    const managed = await this.ops.listManaged();
    for (const m of managed) {
      if (!OWNER_RE.test(m.ownerId) || this.sandboxes.has(m.ownerId)) continue;
      this.sandboxes.set(m.ownerId, this.record(m.ownerId, m.id, m.running));
    }
    return managed.length;
  }

  startWatchdog(intervalMs: number): void {
    this.watchdog = setInterval(() => {
      this.sweep().catch(err => console.error('[sandboxes] watchdog error:', err));
    }, intervalMs);
    this.watchdog.unref();
  }

  stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
  }

  private record(ownerId: string, containerId: string, running: boolean): Sandbox {
    return {
      ownerId,
      containerId,
      running,
      lastActivityAt: this.opts.now(),
      terminals: new TerminalManager(this.ops.shellFactory(containerId), {
        maxTerminals: this.opts.maxTerminals,
        idleMs: this.opts.terminalIdleMs,
        maxOutputChars: this.opts.maxOutputChars,
        cwd: WORKSPACE,
        now: this.opts.now,
      }),
    };
  }

  /** Make sure the owner's sandbox exists and is running. Same owner → same container. */
  async claim(ownerId: string): Promise<{ containerId: string; workspacePath: string; isNew: boolean }> {
    if (!OWNER_RE.test(ownerId)) throw new Error(`Invalid owner id "${ownerId}"`);
    // Concurrent claims for one owner share a single start-up instead of racing to create two containers.
    let pending = this.inflight.get(ownerId);
    if (!pending) {
      pending = this.startOrCreate(ownerId).finally(() => this.inflight.delete(ownerId));
      this.inflight.set(ownerId, pending);
    }
    const { sandbox, isNew } = await pending;
    sandbox.lastActivityAt = this.opts.now();
    return { containerId: sandbox.containerId, workspacePath: WORKSPACE, isNew };
  }

  private async startOrCreate(ownerId: string): Promise<{ sandbox: Sandbox; isNew: boolean }> {
    const existing = this.sandboxes.get(ownerId);
    if (existing?.running) return { sandbox: existing, isNew: false };

    await this.ensureCapacity(ownerId);

    if (existing) {
      try {
        await this.ops.startContainer(existing.containerId);
        existing.running = true;
        return { sandbox: existing, isNew: false };
      } catch (err) {
        // Container was removed behind our back. The volume (the part that matters) is intact: rebuild around it.
        console.warn(`[sandboxes] ${ownerId}: restart failed (${(err as Error).message}); recreating container`);
      }
    }
    const volume = volumeName(ownerId);
    await this.ops.ensureVolume(volume, ownerId);
    const id = await this.ops.createContainer({
      ownerId,
      volume,
      name: `everything-sandbox-${ownerId.toLowerCase()}-${Date.now().toString(36)}`,
    });
    const sandbox = this.record(ownerId, id, true);
    this.sandboxes.set(ownerId, sandbox);
    return { sandbox, isNew: !existing };
  }

  private runningSandboxes(): Sandbox[] {
    return [...this.sandboxes.values()].filter(s => s.running);
  }

  private async ensureCapacity(forOwner: string): Promise<void> {
    const running = this.runningSandboxes().filter(s => s.ownerId !== forOwner);
    if (running.length < this.opts.maxRunning) return;
    const victim = running
      .filter(s => s.terminals.busyCount() === 0)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
    if (!victim) {
      throw new Error(`Sandbox capacity reached: ${running.length} sandboxes are running commands. Try again in a moment.`);
    }
    await this.stopSandbox(victim, 'making room for another sandbox');
  }

  private async stopSandbox(s: Sandbox, reason: string): Promise<void> {
    console.log(`[sandboxes] stopping ${s.ownerId} (${reason}); workspace volume is kept`);
    await s.terminals.closeAll();
    s.running = false;
    await this.ops.stopContainer(s.containerId).catch(err => console.warn(`[sandboxes] stop failed for ${s.ownerId}:`, err));
  }

  /** Stop a sandbox now (e.g. the chat's sandbox toggle was switched off). Files are untouched. */
  async stop(ownerId: string): Promise<boolean> {
    const s = this.sandboxes.get(ownerId);
    if (!s?.running) return false;
    await this.stopSandbox(s, 'explicit stop');
    return true;
  }

  /** Run a command in one of the owner's terminals, creating the sandbox and terminal if needed. */
  async run(ownerId: string, terminal: string | undefined, command: string, timeoutMs: number): Promise<RunResult & { terminal: string }> {
    const name = terminal ?? DEFAULT_TERMINAL;
    const { containerId } = await this.claim(ownerId);
    const s = this.sandboxes.get(ownerId)!;
    await this.logAction(containerId, `[${terminal ? name : DEFAULT_TERMINAL}] ${command}`);
    const result = await s.terminals.run(name, command, timeoutMs);
    s.lastActivityAt = this.opts.now();
    return { ...result, terminal: name };
  }

  /** Append to the action log that read_log serves. The command travels as base64 — it is never parsed by a shell. */
  private async logAction(containerId: string, line: string): Promise<void> {
    const b64 = Buffer.from(`[${new Date().toISOString()}] $ ${line}\n`, 'utf8').toString('base64');
    await this.ops.exec(containerId, `printf %s '${b64}' | base64 -d >> ${ACTION_LOG}`, 5_000).catch(() => undefined);
  }

  /** One-shot exec in a running sandbox, addressed by container id (git_op, read_log). */
  async exec(containerId: string, command: string, timeoutMs: number): Promise<ExecResult> {
    const s = [...this.sandboxes.values()].find(x => x.containerId === containerId && x.running);
    if (!s) throw new Error('Unknown or stopped containerId');
    s.lastActivityAt = this.opts.now();
    return this.ops.exec(containerId, command, timeoutMs);
  }

  listTerminals(ownerId: string): TerminalInfo[] {
    return this.sandboxes.get(ownerId)?.terminals.list() ?? [];
  }

  async closeTerminal(ownerId: string, name: string): Promise<boolean> {
    return (await this.sandboxes.get(ownerId)?.terminals.close(name)) ?? false;
  }

  /** Idle housekeeping: close stale terminals, then stop sandboxes nobody has used for a while. */
  async sweep(): Promise<{ terminalsClosed: number; sandboxesStopped: string[] }> {
    const now = this.opts.now();
    let terminalsClosed = 0;
    const stopped: string[] = [];
    for (const s of this.runningSandboxes()) {
      terminalsClosed += (await s.terminals.sweepIdle()).length;
      if (s.terminals.busyCount() === 0 && now - s.lastActivityAt > this.opts.idleMs) {
        await this.stopSandbox(s, `idle ${Math.round((now - s.lastActivityAt) / 60_000)}m`);
        stopped.push(s.ownerId);
      }
    }
    return { terminalsClosed, sandboxesStopped: stopped };
  }

  status() {
    const now = this.opts.now();
    const all = [...this.sandboxes.values()];
    return {
      maxRunning: this.opts.maxRunning,
      running: all.filter(s => s.running).length,
      sandboxes: all.map(s => ({
        ownerId: s.ownerId,
        containerId: s.containerId,
        running: s.running,
        idleMs: now - s.lastActivityAt,
        terminals: s.terminals.list(),
      })),
    };
  }

  async shutdown(): Promise<void> {
    this.stopWatchdog();
    await Promise.all([...this.sandboxes.values()].map(s => s.terminals.closeAll()));
  }
}
