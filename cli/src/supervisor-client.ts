/**
 * The orchestrator's view of the sandbox-supervisor: byte-level reads of project workspaces (Explorer,
 * report pins) and checkpoints. The host never executes anything on agent files — the supervisor
 * reads via the Docker archive API and runs git only inside the sandbox.
 */

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtime?: string;
}

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: string;
}

const MAX_PIN_BYTES = 2 * 1024 * 1024;

export const SANDBOX_UNREACHABLE = 'The sandbox service is not reachable — start sandbox-supervisor (docker compose up sandbox-supervisor) and try again.';

/** fetch() that turns "connection refused / DNS" into a message a person can act on. */
async function sfetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(15 * 60_000) });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    if (e.name === 'TimeoutError') throw new Error('The sandbox service did not answer in time.');
    throw new Error(SANDBOX_UNREACHABLE);
  }
}

export class OrchestratorSupervisorClient {
  constructor(private readonly baseUrl: string = process.env['SUPERVISOR_URL'] ?? 'http://sandbox-supervisor:3001') {}

  private url(owner: string, suffix: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/sandboxes/${encodeURIComponent(owner)}${suffix}`;
  }

  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let msg = body;
      try { msg = (JSON.parse(body) as { error?: string }).error ?? body; } catch { /* plain text */ }
      throw new Error(msg || `supervisor returned ${res.status}`);
    }
    return (await res.json()) as T;
  }

  async listFiles(owner: string, path: string): Promise<{ path: string; entries: WorkspaceEntry[] }> {
    return this.json(await sfetch(this.url(owner, `/files?path=${encodeURIComponent(path)}`)));
  }

  async readFile(owner: string, path: string): Promise<Buffer> {
    const res = await sfetch(this.url(owner, `/file?path=${encodeURIComponent(path)}`));
    if (!res.ok) await this.json(res);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PIN_BYTES) throw new Error('file too large');
    return buf;
  }

  /** Raw response for streaming a file to the browser (the caller sets safe headers). */
  async fileResponse(owner: string, path: string): Promise<Response> {
    return sfetch(this.url(owner, `/file?path=${encodeURIComponent(path)}`));
  }

  async checkpoint(owner: string, label: string): Promise<Checkpoint> {
    return this.json(await sfetch(this.url(owner, '/checkpoint'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
    }));
  }

  async listCheckpoints(owner: string): Promise<{ checkpoints: Checkpoint[] }> {
    return this.json(await sfetch(this.url(owner, '/checkpoints')));
  }

  async rollback(owner: string, checkpointId: string): Promise<unknown> {
    return this.json(await sfetch(this.url(owner, '/rollback'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkpointId }),
    }));
  }
}

const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', log: 'text/plain',
  ts: 'text/plain', tsx: 'text/plain', js: 'text/plain', py: 'text/plain', sh: 'text/plain', yml: 'text/plain', yaml: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  html: 'text/html', svg: 'image/svg+xml',
};

/** By extension only — the host never sniffs or parses agent files. */
export function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxExec {
  /** Runs `bash -c command` inside the owner's sandbox (started if needed) — never on the host. */
  exec(owner: string, command: string, timeoutMs?: number): Promise<ExecResult>;
}

export class SupervisorExec implements SandboxExec {
  constructor(private readonly baseUrl: string = process.env['SUPERVISOR_URL'] ?? 'http://sandbox-supervisor:3001') {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await sfetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `supervisor returned ${res.status}`);
    return json;
  }

  async exec(owner: string, command: string, timeoutMs = 60_000): Promise<ExecResult> {
    const { containerId } = await this.post<{ containerId: string }>('/claim', { ownerId: owner });
    return this.post<ExecResult>(`/exec/${encodeURIComponent(containerId)}`, { command, timeoutMs });
  }
}

/** POSIX single-quote a value for `bash -c`. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
