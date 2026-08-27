export interface ClaimResult {
  containerId: string;
}

export interface PoolStatus {
  total: number;
  available: number;
  claimed: number;
}

export interface HealthResult {
  status: string;
  pool: PoolStatus;
}

/**
 * Typed HTTP client for the sandbox-supervisor.
 * Never touches docker.sock — all Docker operations go through the supervisor.
 */
export class SupervisorClient {
  constructor(private readonly baseUrl: string) {}

  async claim(): Promise<ClaimResult> {
    const res = await fetch(`${this.baseUrl}/claim`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supervisor /claim failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<ClaimResult>;
  }

  async release(containerId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/release/${containerId}`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supervisor /release failed (${res.status}): ${body}`);
    }
  }

  async exec(
    containerId: string,
    command: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const res = await fetch(`${this.baseUrl}/exec/${containerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, timeoutMs }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supervisor /exec failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<{ stdout: string; stderr: string; exitCode: number }>;
  }

  async health(): Promise<HealthResult> {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`Supervisor /health failed (${res.status})`);
    return res.json() as Promise<HealthResult>;
  }
}
