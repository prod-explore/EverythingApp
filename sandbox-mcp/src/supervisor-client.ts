export interface ClaimResult {
  containerId: string;
  workspacePath: string;
  isNew: boolean;
}

export interface PoolStatus {
  total: number;
  available: number;
  claimed: number;
  leases: Array<{ convId: string; containerId: string; idleSinceMs: number }>;
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

  /**
   * Claim (or re-use) a container for this conversation.
   * Returns the same container on repeated calls for the same convId (sticky lease).
   */
  async claim(conversationId: string): Promise<ClaimResult> {
    const res = await fetch(`${this.baseUrl}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supervisor /claim failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<ClaimResult>;
  }

  /**
   * Explicitly release a conversation's sandbox lease.
   * The container is reset and returned to the pool asynchronously.
   * Idle timeout handles the automatic case; call this for explicit teardown.
   */
  async release(conversationId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supervisor /release failed (${res.status}): ${body}`);
    }
  }

  async exec(
    containerId: string,
    command: string,
    timeoutMs: number,
    conversationId?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const res = await fetch(`${this.baseUrl}/exec/${containerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, timeoutMs, conversationId }),
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
