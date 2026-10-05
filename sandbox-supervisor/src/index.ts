import { SandboxManager } from './sandboxes.js';
import { DockerodeOps, configFromEnv } from './docker.js';
import { createSupervisorApp } from './api.js';

const PORT = parseInt(process.env['SUPERVISOR_PORT'] ?? '3001', 10);
const int = (name: string, fallback: number) => parseInt(process.env[name] ?? String(fallback), 10);

async function main(): Promise<void> {
  const ops = new DockerodeOps(configFromEnv());
  await ops.ensureNetwork();

  const sandboxes = new SandboxManager(ops, {
    maxRunning: int('MAX_RUNNING_SANDBOXES', 2),
    idleMs: int('SANDBOX_IDLE_TIMEOUT_MS', 30 * 60_000),
    terminalIdleMs: int('TERMINAL_IDLE_TIMEOUT_MS', 15 * 60_000),
    maxTerminals: int('MAX_TERMINALS_PER_SANDBOX', 4),
    maxOutputChars: int('TERMINAL_MAX_OUTPUT_CHARS', 200_000),
  });
  const adopted = await sandboxes.adopt();
  console.log(`[supervisor] adopted ${adopted} existing sandbox(es)`);
  sandboxes.startWatchdog(int('SANDBOX_WATCHDOG_INTERVAL_MS', 120_000));

  const app = createSupervisorApp(sandboxes, int('SANDBOX_DEFAULT_TIMEOUT_MS', 30_000));
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`[supervisor] listening on port ${PORT}`));

  // Containers and volumes are deliberately left alone on shutdown; only the shell sessions end.
  const stop = () => {
    server.close();
    sandboxes.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch(err => {
  console.error('[supervisor] fatal startup error:', err);
  process.exit(1);
});
