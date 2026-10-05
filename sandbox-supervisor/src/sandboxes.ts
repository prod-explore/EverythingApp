import { TerminalManager, DEFAULT_TERMINAL, type RunResult, type ShellFactory, type TerminalInfo } from './terminals.js';
import {
  ExplorerError as HttpError,
  META_DIR,
  WORKSPACE,
  listDirectory,
  readFile,
  type ArchiveOps,
  type FileResult,
  type Listing,
} from './explorer.js';
import {
  ROLLBACK_NOT_FOUND,
  checkpointScript,
  listScript,
  newCheckpointId,
  parseCheckpointOutput,
  parseListOutput,
  rollbackScript,
  validCheckpointId,
  type Checkpoint,
} from './checkpoints.js';

export { HttpError, WORKSPACE };

/**
 * One sandbox per *owner* — a project, or a standalone chat when it has none.
 *
 * - The workspace is a named Docker volume mounted at /workspace. It lives exactly as long as the project:
 *   only an explicit destroy (project deletion → DELETE /sandboxes/:owner/volume) removes it.
 * - Idle sandboxes are STOPPED, not removed. A container that has been stopped for longer than
 *   `containerTtlMs` (default 7 days) is garbage-collected; the volume stays and the next claim builds a
 *   fresh container around it. (The root filesystem is read-only, so nothing of value lives in the container.)
 * - At most `maxRunning` sandboxes run at once (the Pi has 8 GB shared with other services); claiming
 *   a new one stops the least recently used idle sandbox, or fails clearly if every one is busy.
 * - A CPU watchdog samples running sandboxes: sustained high CPU while the agent is not doing anything
 *   records a warning, and if it goes on, the sandbox is stopped.
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

export interface ManagedContainer {
  id: string;
  ownerId: string;
  running: boolean;
  /** When a stopped container stopped (epoch ms), if Docker knows. */
  stoppedAt?: number;
}

/** Everything the manager needs from Docker. dockerode implements it (docker.ts); tests fake it. */
export interface DockerOps extends ArchiveOps {
  /** Returns true when the volume was created now (a brand-new, empty workspace). */
  ensureVolume(volume: string, ownerId: string): Promise<boolean>;
  volumeExists(volume: string): Promise<boolean>;
  /** false if it did not exist. */
  removeVolume(volume: string): Promise<boolean>;
  /** Creates (and by default starts) a container with the volume mounted at /workspace. Returns its id. */
  createContainer(spec: SandboxSpec, opts?: { start?: boolean }): Promise<string>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string): Promise<void>;
  /** Removes a container, never its volume. false if it did not exist. */
  removeContainer(id: string): Promise<boolean>;
  /** Every container this supervisor created, running or not (adopted after a supervisor restart). */
  listManaged(): Promise<ManagedContainer[]>;
  /** CPU usage as a percentage of the container's CPU limit (one sample). */
  cpuPercent(id: string): Promise<number>;
  exec(id: string, command: string, timeoutMs: number): Promise<ExecResult>;
  shellFactory(id: string): ShellFactory;
}

export interface CpuWatchdogOptions {
  /** Percent of the container's CPU limit. */
  thresholdPercent?: number;
  /** Consecutive samples above the threshold before a warning is recorded. */
  samples?: number;
  /** Further consecutive hot samples after the warning before the sandbox is stopped. */
  stopAfterSamples?: number;
  /** Only act when the agent has not run anything (exec / terminal command) for this long. */
  agentIdleMs?: number;
}

export interface SandboxManagerOptions {
  maxRunning?: number;
  /** A sandbox with no activity for this long is stopped (its volume stays). */
  idleMs?: number;
  /** A container stopped for this long is removed (its volume stays). */
  containerTtlMs?: number;
  terminalIdleMs?: number;
  maxTerminals?: number;
  maxOutputChars?: number;
  /** Explorer: largest file served. */
  maxFileBytes?: number;
  checkpointTimeoutMs?: number;
  cpu?: CpuWatchdogOptions;
  now?: () => number;
}

export interface SandboxEvent {
  type: 'cpu_high' | 'cpu_stopped';
  /** ISO timestamp */
  at: string;
  message: string;
  cpuPercent: number;
}

interface Sandbox {
  ownerId: string;
  containerId: string;
  running: boolean;
  lastActivityAt: number;
  /** Last exec / terminal command / claim by the agent (UI browsing does not count). */
  lastAgentActivityAt: number;
  stoppedAt: number | null;
  terminals: TerminalManager;
  cpu: { last: number | null; hot: number; warned: boolean; hotSinceWarn: number };
  events: SandboxEvent[];
}

const OWNER_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const ACTION_LOG = `${META_DIR}/actions.log`;
const MAX_EVENTS = 20;

export function volumeName(ownerId: string): string {
  return `everything-workspace-${ownerId.toLowerCase()}`;
}

export class SandboxManager {
  private readonly sandboxes = new Map<string, Sandbox>();
  private readonly inflight = new Map<string, Promise<{ sandbox: Sandbox; isNew: boolean }>>();
  private readonly materializing = new Map<string, Promise<Sandbox | null>>();
  private watchdog: NodeJS.Timeout | undefined;
  private cpuTimer: NodeJS.Timeout | undefined;
  private readonly opts: Required<Omit<SandboxManagerOptions, 'cpu'>> & { cpu: Required<CpuWatchdogOptions> };

  constructor(
    private readonly ops: DockerOps,
    opts: SandboxManagerOptions = {},
  ) {
    this.opts = {
      maxRunning: opts.maxRunning ?? 2,
      idleMs: opts.idleMs ?? 30 * 60_000,
      containerTtlMs: opts.containerTtlMs ?? 7 * 24 * 3600_000,
      terminalIdleMs: opts.terminalIdleMs ?? 15 * 60_000,
      maxTerminals: opts.maxTerminals ?? 4,
      maxOutputChars: opts.maxOutputChars ?? 200_000,
      maxFileBytes: opts.maxFileBytes ?? 2 * 1024 * 1024,
      checkpointTimeoutMs: opts.checkpointTimeoutMs ?? 120_000,
      cpu: {
        thresholdPercent: opts.cpu?.thresholdPercent ?? 90,
        samples: opts.cpu?.samples ?? 5,
        stopAfterSamples: opts.cpu?.stopAfterSamples ?? 5,
        agentIdleMs: opts.cpu?.agentIdleMs ?? 10 * 60_000,
      },
      now: opts.now ?? Date.now,
    };
  }

  static validOwner(ownerId: string): boolean {
    return OWNER_RE.test(ownerId);
  }

  get maxFileBytes(): number {
    return this.opts.maxFileBytes;
  }

  /** Re-attach to sandboxes that already exist (supervisor restart). Their shells are gone; their files are not. */
  async adopt(): Promise<number> {
    const managed = await this.ops.listManaged();
    for (const m of managed) {
      if (!OWNER_RE.test(m.ownerId) || this.sandboxes.has(m.ownerId)) continue;
      const s = this.record(m.ownerId, m.id, m.running);
      if (!m.running) s.stoppedAt = m.stoppedAt ?? this.opts.now();
      this.sandboxes.set(m.ownerId, s);
    }
    return managed.length;
  }

  startWatchdog(intervalMs: number): void {
    this.watchdog = setInterval(() => {
      this.sweep().catch(err => console.error('[sandboxes] watchdog error:', err));
    }, intervalMs);
    this.watchdog.unref();
  }

  startCpuWatchdog(intervalMs: number): void {
    this.cpuTimer = setInterval(() => {
      this.sampleCpu().catch(err => console.error('[sandboxes] cpu watchdog error:', err));
    }, intervalMs);
    this.cpuTimer.unref();
  }

  stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.cpuTimer) clearInterval(this.cpuTimer);
  }

  private record(ownerId: string, containerId: string, running: boolean): Sandbox {
    const now = this.opts.now();
    return {
      ownerId,
      containerId,
      running,
      lastActivityAt: now,
      lastAgentActivityAt: now,
      stoppedAt: running ? null : now,
      cpu: { last: null, hot: 0, warned: false, hotSinceWarn: 0 },
      events: [],
      terminals: new TerminalManager(this.ops.shellFactory(containerId), {
        maxTerminals: this.opts.maxTerminals,
        idleMs: this.opts.terminalIdleMs,
        maxOutputChars: this.opts.maxOutputChars,
        cwd: WORKSPACE,
        now: this.opts.now,
      }),
    };
  }

  private touchAgent(s: Sandbox): void {
    const now = this.opts.now();
    s.lastActivityAt = now;
    s.lastAgentActivityAt = now;
  }

  /** Make sure the owner's sandbox exists and is running. Same owner → same container. */
  async claim(ownerId: string): Promise<{ containerId: string; workspacePath: string; isNew: boolean }> {
    if (!OWNER_RE.test(ownerId)) throw new HttpError(`Invalid owner id "${ownerId}"`, 400);
    // Concurrent claims for one owner share a single start-up instead of racing to create two containers.
    let pending = this.inflight.get(ownerId);
    if (!pending) {
      pending = this.startOrCreate(ownerId).finally(() => this.inflight.delete(ownerId));
      this.inflight.set(ownerId, pending);
    }
    const { sandbox, isNew } = await pending;
    this.touchAgent(sandbox);
    return { containerId: sandbox.containerId, workspacePath: WORKSPACE, isNew };
  }

  private async startOrCreate(ownerId: string): Promise<{ sandbox: Sandbox; isNew: boolean }> {
    await this.materializing.get(ownerId)?.catch(() => undefined);
    const existing = this.sandboxes.get(ownerId);
    if (existing?.running) return { sandbox: existing, isNew: false };

    await this.ensureCapacity(ownerId);

    if (existing) {
      try {
        await this.ops.startContainer(existing.containerId);
        existing.running = true;
        existing.stoppedAt = null;
        return { sandbox: existing, isNew: false };
      } catch (err) {
        // Container was removed behind our back. The volume (the part that matters) is intact: rebuild around it.
        console.warn(`[sandboxes] ${ownerId}: restart failed (${(err as Error).message}); recreating container`);
      }
    }
    const volume = volumeName(ownerId);
    const created = await this.ops.ensureVolume(volume, ownerId);
    const id = await this.ops.createContainer(this.spec(ownerId));
    const sandbox = this.record(ownerId, id, true);
    this.sandboxes.set(ownerId, sandbox);
    return { sandbox, isNew: created };
  }

  private spec(ownerId: string): SandboxSpec {
    return {
      ownerId,
      volume: volumeName(ownerId),
      name: `everything-sandbox-${ownerId.toLowerCase()}-${Date.now().toString(36)}`,
    };
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
      throw new HttpError(`Sandbox capacity reached: ${running.length} sandboxes are running commands. Try again in a moment.`, 503);
    }
    await this.stopSandbox(victim, 'making room for another sandbox');
  }

  private async stopSandbox(s: Sandbox, reason: string): Promise<void> {
    console.log(`[sandboxes] stopping ${s.ownerId} (${reason}); workspace volume is kept`);
    await s.terminals.closeAll();
    s.running = false;
    s.stoppedAt = this.opts.now();
    s.cpu.hot = 0;
    s.cpu.hotSinceWarn = 0;
    s.cpu.warned = false;
    await this.ops.stopContainer(s.containerId).catch(err => console.warn(`[sandboxes] stop failed for ${s.ownerId}:`, err));
  }

  /** Stop a sandbox now (e.g. the chat's sandbox toggle was switched off). Files are untouched. */
  async stop(ownerId: string): Promise<boolean> {
    const s = this.sandboxes.get(ownerId);
    if (!s?.running) return false;
    await this.stopSandbox(s, 'explicit stop');
    return true;
  }

  /**
   * Project deletion: remove the container(s) AND the workspace volume. The only code path that deletes
   * a volume.
   */
  async destroy(ownerId: string): Promise<{ containersRemoved: number; volumeRemoved: boolean }> {
    if (!OWNER_RE.test(ownerId)) throw new HttpError(`Invalid owner id "${ownerId}"`, 400);
    await this.inflight.get(ownerId)?.catch(() => undefined);
    await this.materializing.get(ownerId)?.catch(() => undefined);
    const ids = new Set<string>();
    const s = this.sandboxes.get(ownerId);
    if (s) {
      await s.terminals.closeAll();
      ids.add(s.containerId);
      this.sandboxes.delete(ownerId);
    }
    for (const m of await this.ops.listManaged()) if (m.ownerId === ownerId) ids.add(m.id);
    let containersRemoved = 0;
    for (const id of ids) if (await this.ops.removeContainer(id)) containersRemoved++;
    const volumeRemoved = await this.ops.removeVolume(volumeName(ownerId));
    console.log(`[sandboxes] destroyed ${ownerId}: ${containersRemoved} container(s), volume ${volumeRemoved ? 'removed' : 'absent'}`);
    return { containersRemoved, volumeRemoved };
  }

  /** Run a command in one of the owner's terminals, creating the sandbox and terminal if needed. */
  async run(ownerId: string, terminal: string | undefined, command: string, timeoutMs: number): Promise<RunResult & { terminal: string }> {
    const name = terminal ?? DEFAULT_TERMINAL;
    const { containerId } = await this.claim(ownerId);
    const s = this.sandboxes.get(ownerId)!;
    await this.logAction(containerId, `[${terminal ? name : DEFAULT_TERMINAL}] ${command}`);
    let result: RunResult;
    try {
      result = await s.terminals.run(name, command, timeoutMs);
    } catch (err) {
      if (/Terminal limit reached/.test((err as Error).message)) throw new HttpError((err as Error).message, 429);
      if (/Invalid terminal name/.test((err as Error).message)) throw new HttpError((err as Error).message, 400);
      throw err;
    }
    this.touchAgent(s);
    return { ...result, terminal: name };
  }

  /** Append to the action log that read_log serves. The command travels as base64 — it is never parsed by a shell. */
  private async logAction(containerId: string, line: string): Promise<void> {
    const b64 = Buffer.from(`[${new Date().toISOString()}] $ ${line}\n`, 'utf8').toString('base64');
    await this.ops
      .exec(containerId, `mkdir -p ${META_DIR} && printf %s '${b64}' | base64 -d >> ${ACTION_LOG}`, 5_000)
      .catch(() => undefined);
  }

  /** One-shot exec in a running sandbox, addressed by container id (git_op, read_log). */
  async exec(containerId: string, command: string, timeoutMs: number): Promise<ExecResult> {
    const s = [...this.sandboxes.values()].find(x => x.containerId === containerId && x.running);
    if (!s) throw new HttpError('Unknown or stopped containerId', 404);
    this.touchAgent(s);
    return this.ops.exec(containerId, command, timeoutMs);
  }

  listTerminals(ownerId: string): TerminalInfo[] {
    return this.sandboxes.get(ownerId)?.terminals.list() ?? [];
  }

  async closeTerminal(ownerId: string, name: string): Promise<boolean> {
    return (await this.sandboxes.get(ownerId)?.terminals.close(name)) ?? false;
  }

  // ─── Workspace explorer (byte-level, read-only; does not wake or keep alive a sandbox) ────────────────

  /**
   * The container to browse. If the owner's container was garbage-collected but the volume exists, a
   * STOPPED container is created around it (nothing runs) so the archive API can read the files.
   */
  private async browseTarget(ownerId: string): Promise<Sandbox | null> {
    if (!OWNER_RE.test(ownerId)) throw new HttpError(`Invalid owner id "${ownerId}"`, 400);
    await this.inflight.get(ownerId)?.catch(() => undefined);
    const existing = this.sandboxes.get(ownerId);
    if (existing) return existing;
    let pending = this.materializing.get(ownerId);
    if (!pending) {
      pending = (async () => {
        if (!(await this.ops.volumeExists(volumeName(ownerId)))) return null;
        const id = await this.ops.createContainer(this.spec(ownerId), { start: false });
        const s = this.record(ownerId, id, false);
        this.sandboxes.set(ownerId, s);
        return s;
      })().finally(() => this.materializing.delete(ownerId));
      this.materializing.set(ownerId, pending);
    }
    return pending;
  }

  async listFiles(ownerId: string, path: unknown): Promise<Listing> {
    const s = await this.browseTarget(ownerId);
    return listDirectory(this.ops, s?.containerId ?? null, path, {
      exec: s?.running ? cmd => this.ops.exec(s.containerId, cmd, 15_000) : undefined,
    });
  }

  async readFile(ownerId: string, path: unknown): Promise<FileResult> {
    const s = await this.browseTarget(ownerId);
    return readFile(this.ops, s?.containerId ?? null, path, this.opts.maxFileBytes);
  }

  // ─── Checkpoints (git inside the sandbox) ─────────────────────────────────────────────────────────

  async checkpoint(ownerId: string, label: unknown): Promise<Checkpoint & { warnings: string[] }> {
    const text = typeof label === 'string' && label.trim() ? label.trim().slice(0, 500) : 'checkpoint';
    const { containerId } = await this.claim(ownerId);
    const now = this.opts.now();
    const id = newCheckpointId(now);
    const r = await this.ops.exec(containerId, checkpointScript(id, text), this.opts.checkpointTimeoutMs);
    if (r.exitCode !== 0) throw new HttpError(`checkpoint failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 2000)}`, 500);
    const { commit, warnings } = parseCheckpointOutput(r.stdout);
    await this.logAction(containerId, `[checkpoint] cp-${id} ${text.split('\n')[0]}`);
    return { id, label: text.split('\n')[0]!, commit, createdAt: new Date(now).toISOString(), warnings };
  }

  async listCheckpoints(ownerId: string): Promise<Checkpoint[]> {
    if (!OWNER_RE.test(ownerId)) throw new HttpError(`Invalid owner id "${ownerId}"`, 400);
    // Never create a workspace just to say it has no checkpoints.
    if (!this.sandboxes.has(ownerId) && !(await this.ops.volumeExists(volumeName(ownerId)))) return [];
    const { containerId } = await this.claim(ownerId);
    const r = await this.ops.exec(containerId, listScript(), 30_000);
    if (r.exitCode !== 0) throw new HttpError(`listing checkpoints failed (exit ${r.exitCode}): ${r.stderr.trim()}`, 500);
    return parseListOutput(r.stdout);
  }

  async rollback(ownerId: string, checkpointId: unknown): Promise<{ checkpointId: string; commit: string }> {
    if (!validCheckpointId(checkpointId)) throw new HttpError('checkpointId is required and must look like "<base36>-<hex>"', 400);
    const { containerId } = await this.claim(ownerId);
    const s = this.sandboxes.get(ownerId)!;
    if (s.terminals.busyCount() > 0) {
      throw new HttpError('A command is still running in this sandbox; wait for it (or close the terminal) before rolling back.', 409);
    }
    await this.logAction(containerId, `[rollback] cp-${checkpointId}`);
    const r = await this.ops.exec(containerId, rollbackScript(checkpointId), this.opts.checkpointTimeoutMs);
    if (r.exitCode === ROLLBACK_NOT_FOUND) throw new HttpError(`No checkpoint "${checkpointId}"`, 404);
    if (r.exitCode !== 0) throw new HttpError(`rollback failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 2000)}`, 500);
    return { checkpointId, commit: parseCheckpointOutput(r.stdout).commit };
  }

  // ─── Housekeeping ─────────────────────────────────────────────────────────────────────────────────

  /** Idle housekeeping: close stale terminals, stop idle sandboxes, remove long-stopped containers. */
  async sweep(): Promise<{ terminalsClosed: number; sandboxesStopped: string[]; containersRemoved: string[] }> {
    const now = this.opts.now();
    let terminalsClosed = 0;
    const stopped: string[] = [];
    const removed: string[] = [];
    for (const s of this.runningSandboxes()) {
      terminalsClosed += (await s.terminals.sweepIdle()).length;
      if (s.terminals.busyCount() === 0 && now - s.lastActivityAt > this.opts.idleMs) {
        await this.stopSandbox(s, `idle ${Math.round((now - s.lastActivityAt) / 60_000)}m`);
        stopped.push(s.ownerId);
      }
    }
    for (const s of [...this.sandboxes.values()]) {
      if (s.running || s.stoppedAt === null || now - s.stoppedAt <= this.opts.containerTtlMs) continue;
      if (this.inflight.has(s.ownerId)) continue;
      try {
        await this.ops.removeContainer(s.containerId);
        this.sandboxes.delete(s.ownerId);
        removed.push(s.ownerId);
        console.log(`[sandboxes] removed container of ${s.ownerId} (stopped ${Math.round((now - s.stoppedAt) / 86_400_000)}d); volume kept`);
      } catch (err) {
        console.warn(`[sandboxes] container GC failed for ${s.ownerId}:`, err);
      }
    }
    return { terminalsClosed, sandboxesStopped: stopped, containersRemoved: removed };
  }

  private addEvent(s: Sandbox, ev: Omit<SandboxEvent, 'at'>): void {
    s.events.push({ ...ev, at: new Date(this.opts.now()).toISOString() });
    if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
  }

  /**
   * One CPU watchdog tick. A sandbox is "hot" after `samples` consecutive samples above the threshold; if
   * the agent has been inactive for `agentIdleMs` (a running terminal command counts as activity), a
   * warning is recorded; `stopAfterSamples` further hot samples later the sandbox is stopped.
   */
  async sampleCpu(): Promise<{ warned: string[]; stopped: string[] }> {
    const c = this.opts.cpu;
    const now = this.opts.now();
    const warned: string[] = [];
    const stopped: string[] = [];
    for (const s of this.runningSandboxes()) {
      let pct: number;
      try {
        pct = await this.ops.cpuPercent(s.containerId);
      } catch {
        continue;
      }
      s.cpu.last = pct;
      if (s.terminals.busyCount() > 0) s.lastAgentActivityAt = now;
      if (pct < c.thresholdPercent) {
        s.cpu.hot = 0;
        s.cpu.hotSinceWarn = 0;
        s.cpu.warned = false;
        continue;
      }
      s.cpu.hot++;
      const agentIdleFor = now - s.lastAgentActivityAt;
      if (agentIdleFor < c.agentIdleMs) continue;
      if (!s.cpu.warned) {
        if (s.cpu.hot < c.samples) continue;
        s.cpu.warned = true;
        s.cpu.hotSinceWarn = 0;
        const message = `CPU at ${pct.toFixed(0)}% for ${s.cpu.hot} consecutive samples with no agent activity for ${Math.round(agentIdleFor / 60_000)}m; it will be stopped if this continues`;
        console.warn(`[sandboxes] ${s.ownerId}: ${message}`);
        this.addEvent(s, { type: 'cpu_high', message, cpuPercent: pct });
        warned.push(s.ownerId);
        continue;
      }
      s.cpu.hotSinceWarn++;
      if (s.cpu.hotSinceWarn >= c.stopAfterSamples) {
        const message = `stopped: CPU stayed at ${pct.toFixed(0)}% with no agent activity (workspace kept)`;
        console.warn(`[sandboxes] ${s.ownerId}: ${message}`);
        this.addEvent(s, { type: 'cpu_stopped', message, cpuPercent: pct });
        await this.stopSandbox(s, 'cpu watchdog');
        stopped.push(s.ownerId);
      }
    }
    return { warned, stopped };
  }

  private describe(s: Sandbox, now: number) {
    return {
      ownerId: s.ownerId,
      containerId: s.containerId,
      running: s.running,
      idleMs: now - s.lastActivityAt,
      agentIdleMs: now - s.lastAgentActivityAt,
      stoppedAt: s.stoppedAt === null ? null : new Date(s.stoppedAt).toISOString(),
      cpuPercent: s.cpu.last,
      cpuHot: s.cpu.warned,
      warnings: [...s.events],
      terminals: s.terminals.list(),
    };
  }

  sandboxStatus(ownerId: string) {
    const s = this.sandboxes.get(ownerId);
    return s ? this.describe(s, this.opts.now()) : null;
  }

  status() {
    const now = this.opts.now();
    const all = [...this.sandboxes.values()];
    return {
      maxRunning: this.opts.maxRunning,
      running: all.filter(s => s.running).length,
      warnings: all
        .flatMap(s => s.events.map(e => ({ ownerId: s.ownerId, ...e })))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, MAX_EVENTS),
      sandboxes: all.map(s => this.describe(s, now)),
    };
  }

  async shutdown(): Promise<void> {
    this.stopWatchdog();
    await Promise.all([...this.sandboxes.values()].map(s => s.terminals.closeAll()));
  }
}
