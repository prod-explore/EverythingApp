export interface ClaimResult {
  containerId: string;
  workspacePath: string;
  isNew: boolean;
}

export interface TerminalRunResult {
  terminal: string;
  /** stdout and stderr merged, in the order the command wrote them. */
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  /** The shell no longer exists; the next command in this terminal starts a fresh one (cwd/env reset). */
  terminalClosed: boolean;
}

export interface TerminalInfo {
  name: string;
  busy: boolean;
  idleMs: number;
  ageMs: number;
}

export interface HealthResult {
  status: string;
  maxRunning: number;
  running: number;
  sandboxes: Array<{ ownerId: string; containerId: string; running: boolean; idleMs: number; terminals: TerminalInfo[] }>;
}

/**
 * Typed HTTP client for the sandbox-supervisor.
 * Never touches docker.sock — all Docker operations go through the supervisor.
 *
 * `ownerId` is the project id when the chat belongs to a project, else the chat's own id: every chat in a
 * project shares that project's sandbox and workspace.
 */
export class SupervisorClient {
  constructor(private readonly baseUrl: string) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Supervisor ${path} failed (${res.status}): ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  /** Start (or reuse) the owner's sandbox. Same owner → same container, same persistent /workspace. */
  claim(ownerId: string): Promise<ClaimResult> {
    return this.post('/claim', { ownerId });
  }

  /** Stop the sandbox now. Its workspace is kept. */
  async release(ownerId: string): Promise<void> {
    await this.post('/release', { ownerId });
  }

  runInTerminal(ownerId: string, terminal: string | undefined, command: string, timeoutMs: number): Promise<TerminalRunResult> {
    return this.post('/terminal/run', { ownerId, terminal, command, timeoutMs });
  }

  async listTerminals(ownerId: string): Promise<TerminalInfo[]> {
    const res = await fetch(`${this.baseUrl}/terminals?ownerId=${encodeURIComponent(ownerId)}`);
    if (!res.ok) throw new Error(`Supervisor /terminals failed (${res.status}): ${await res.text()}`);
    return ((await res.json()) as { terminals: TerminalInfo[] }).terminals;
  }

  async closeTerminal(ownerId: string, terminal: string): Promise<boolean> {
    return (await this.post<{ closed: boolean }>('/terminal/close', { ownerId, terminal })).closed;
  }

  /** One-shot command in a running sandbox (git_op, read_log). Not a terminal: no shell state carries over. */
  exec(containerId: string, command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.post(`/exec/${encodeURIComponent(containerId)}`, { command, timeoutMs });
  }

  async health(): Promise<HealthResult> {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`Supervisor /health failed (${res.status})`);
    return res.json() as Promise<HealthResult>;
  }
}
