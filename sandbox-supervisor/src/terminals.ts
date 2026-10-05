import { randomBytes } from 'node:crypto';

/**
 * Persistent shell sessions ("terminals") inside a sandbox container.
 *
 * A terminal is one long-lived `bash` whose cwd, env vars, shell functions and background jobs survive
 * between commands — the way an IDE terminal behaves. Commands are fed to it over stdin and delimited
 * with a per-terminal random sentinel, which is how we know where one command's output ends and what
 * its exit code was. The shell itself comes from a ShellFactory, so this file knows nothing about
 * Docker and is tested against a plain local bash.
 */

export interface ShellProcess {
  write(data: string): void;
  /** stdout and stderr, already merged into one stream. */
  onData(cb: (chunk: string) => void): void;
  onExit(cb: () => void): void;
  /** Kill the shell and everything it started. Must be safe to call more than once. */
  kill(): Promise<void>;
}

export type ShellFactory = () => Promise<ShellProcess>;

export interface RunResult {
  output: string;
  /** null when the shell died or timed out before the command reported one. */
  exitCode: number | null;
  timedOut: boolean;
  /** Output beyond maxOutputChars was dropped. */
  truncated: boolean;
  /** The terminal no longer exists (timeout, `exit`, crash); the next run with this name starts a fresh shell. */
  terminalClosed: boolean;
}

export interface TerminalInfo {
  name: string;
  busy: boolean;
  idleMs: number;
  ageMs: number;
}

export interface TerminalManagerOptions {
  maxTerminals?: number;
  /** Close a terminal that has been idle this long (never one that is running a command). */
  idleMs?: number;
  maxOutputChars?: number;
  cwd?: string;
  now?: () => number;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const DEFAULT_TERMINAL = 'main';
const WINDOW = 1024;

class Terminal {
  readonly createdAt: number;
  lastActivityAt: number;
  busy = false;
  closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly marker: string;
  private listener: ((chunk: string) => void) | null = null;
  private exitListener: (() => void) | null = null;

  constructor(
    readonly name: string,
    private readonly shell: ShellProcess,
    private readonly opts: Required<Pick<TerminalManagerOptions, 'maxOutputChars' | 'now'>>,
    private readonly onClosed: (t: Terminal) => void,
  ) {
    this.createdAt = opts.now();
    this.lastActivityAt = this.createdAt;
    // Random per terminal, so a command (or a file it prints) cannot fake "I'm done" for the next one.
    this.marker = `__EA_END_${randomBytes(9).toString('hex')}_`;
    shell.onData(chunk => this.listener?.(chunk));
    shell.onExit(() => {
      this.markClosed();
      this.exitListener?.();
    });
  }

  init(cwd: string): void {
    // One merged stream, no prompt noise, start in the workspace. A missing cwd is not fatal.
    this.shell.write(`exec 2>&1\nPS1=''\ncd ${JSON.stringify(cwd)} 2>/dev/null\n`);
  }

  run(command: string, timeoutMs: number): Promise<RunResult> {
    const job = this.queue.then(() => this.execute(command, timeoutMs));
    this.queue = job.catch(() => undefined); // a failed run must not wedge the queue
    return job;
  }

  private execute(command: string, timeoutMs: number): Promise<RunResult> {
    if (this.closed) {
      return Promise.resolve({ output: '', exitCode: null, timedOut: false, truncated: false, terminalClosed: true });
    }
    this.busy = true;
    this.lastActivityAt = this.opts.now();

    return new Promise<RunResult>(resolve => {
      const max = this.opts.maxOutputChars;
      let head = '';
      let window = '';
      let truncated = false;
      let settled = false;
      const endRe = new RegExp(`\\n${this.marker}(\\d+)__\\n`);

      const finish = (result: Omit<RunResult, 'truncated' | 'terminalClosed'> & { terminalClosed?: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listener = null;
        this.exitListener = null;
        this.busy = false;
        this.lastActivityAt = this.opts.now();
        resolve({ truncated, terminalClosed: this.closed, ...result });
      };

      const clean = (): string => {
        const cut = head.lastIndexOf(`\n${this.marker}`);
        const text = cut === -1 ? head : head.slice(0, cut);
        return truncated ? `${text}\n[output truncated at ${max} characters]` : text;
      };

      this.listener = chunk => {
        if (head.length < max) {
          head += chunk;
          if (head.length > max) {
            // Keep scanning for the end marker, but stop growing memory.
            truncated = true;
            head = head.slice(0, max);
          }
        } else {
          truncated = true;
        }
        window = (window + chunk).slice(-WINDOW);
        const m = endRe.exec(window);
        if (m) finish({ output: clean(), exitCode: Number(m[1]), timedOut: false });
      };

      this.exitListener = () => finish({ output: clean(), exitCode: null, timedOut: false });

      const timer = setTimeout(() => {
        const partial = clean();
        // Killing the shell fires its exit event; that must not win over the timeout verdict.
        this.exitListener = null;
        this.listener = null;
        void this.close().then(() => finish({ output: partial, exitCode: null, timedOut: true }));
      }, timeoutMs);

      // base64 keeps quotes, heredocs and newlines in the command from ever being parsed by the outer
      // shell; `< /dev/null` stops a command that reads stdin from swallowing the lines that follow.
      const b64 = Buffer.from(command, 'utf8').toString('base64');
      this.shell.write(
        `eval "$(printf %s '${b64}' | base64 -d)" < /dev/null\n` +
          `__ea_rc=$?\nprintf '\\n${this.marker}%s__\\n' "$__ea_rc"\n`,
      );
    });
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClosed(this);
  }

  async close(): Promise<void> {
    this.markClosed();
    await this.shell.kill().catch(() => undefined);
  }
}

export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();
  private readonly creating = new Map<string, Promise<Terminal>>();
  private readonly opts: Required<TerminalManagerOptions>;

  constructor(
    private readonly factory: ShellFactory,
    opts: TerminalManagerOptions = {},
  ) {
    this.opts = {
      maxTerminals: opts.maxTerminals ?? 4,
      idleMs: opts.idleMs ?? 15 * 60_000,
      maxOutputChars: opts.maxOutputChars ?? 200_000,
      cwd: opts.cwd ?? '/workspace',
      now: opts.now ?? Date.now,
    };
  }

  static validName(name: string): boolean {
    return NAME_RE.test(name);
  }

  async run(name: string, command: string, timeoutMs: number): Promise<RunResult> {
    const terminal = await this.getOrCreate(name);
    return terminal.run(command, timeoutMs);
  }

  private async getOrCreate(name: string): Promise<Terminal> {
    if (!NAME_RE.test(name)) throw new Error(`Invalid terminal name "${name}" (use letters, digits, _ or -, max 32 chars)`);
    const existing = this.terminals.get(name);
    if (existing && !existing.closed) return existing;
    const pending = this.creating.get(name);
    if (pending) return pending;

    if (this.terminals.size + this.creating.size >= this.opts.maxTerminals) {
      throw new Error(
        `Terminal limit reached (${this.opts.maxTerminals}). Close one first: ${[...this.terminals.keys()].join(', ')}`,
      );
    }
    const promise = (async () => {
      const shell = await this.factory();
      const terminal = new Terminal(name, shell, this.opts, t => {
        if (this.terminals.get(t.name) === t) this.terminals.delete(t.name);
      });
      terminal.init(this.opts.cwd);
      this.terminals.set(name, terminal);
      return terminal;
    })();
    this.creating.set(name, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(name);
    }
  }

  list(): TerminalInfo[] {
    const now = this.opts.now();
    return [...this.terminals.values()].map(t => ({
      name: t.name,
      busy: t.busy,
      idleMs: t.busy ? 0 : now - t.lastActivityAt,
      ageMs: now - t.createdAt,
    }));
  }

  busyCount(): number {
    return [...this.terminals.values()].filter(t => t.busy).length;
  }

  count(): number {
    return this.terminals.size;
  }

  async close(name: string): Promise<boolean> {
    const t = this.terminals.get(name);
    if (!t) return false;
    await t.close();
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.terminals.values()].map(t => t.close()));
  }

  /** Closes idle terminals. Returns the names it closed. */
  async sweepIdle(): Promise<string[]> {
    const now = this.opts.now();
    const stale = [...this.terminals.values()].filter(t => !t.busy && now - t.lastActivityAt > this.opts.idleMs);
    await Promise.all(stale.map(t => t.close()));
    return stale.map(t => t.name);
  }
}
