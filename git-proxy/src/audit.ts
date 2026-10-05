// Audit trail: one JSON line per event on stdout, mirrored (fire-and-forget) to the orchestrator.
// Never put proxy tokens or GitHub credentials in an event.
export type AuditEvent = { type: string } & Record<string, unknown>;

export class AuditLog {
  constructor(
    private readonly forward: ((e: Record<string, unknown>) => void) | null,
    private readonly write: (line: string) => void = line => process.stdout.write(line + '\n'),
  ) {}

  emit(event: AuditEvent): void {
    const record = { ts: new Date().toISOString(), service: 'git-proxy', ...event };
    try {
      this.write(JSON.stringify(record));
    } catch {
      /* never let logging break a request */
    }
    this.forward?.(record);
  }
}
