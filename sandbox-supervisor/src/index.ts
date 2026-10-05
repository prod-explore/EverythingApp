import { SandboxManager } from './sandboxes.js';
import { DockerodeOps, configFromEnv } from './docker.js';
import { createSupervisorApp } from './api.js';

const PORT = parseInt(process.env['SUPERVISOR_PORT'] ?? '3001', 10);
const num = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

async function main(): Promise<void> {
  const ops = new DockerodeOps(configFromEnv());
  await ops.ensureNetwork();

  const sandboxes = new SandboxManager(ops, {
    maxRunning: num('MAX_RUNNING_SANDBOXES', 2),
    idleMs: num('SANDBOX_IDLE_TIMEOUT_MS', 30 * 60_000),
    containerTtlMs: num('SANDBOX_CONTAINER_TTL_DAYS', 7) * 24 * 3600_000,
    terminalIdleMs: num('TERMINAL_IDLE_TIMEOUT_MS', 15 * 60_000),
    maxTerminals: num('MAX_TERMINALS_PER_SANDBOX', 4),
    maxOutputChars: num('TERMINAL_MAX_OUTPUT_CHARS', 200_000),
    maxFileBytes: num('SANDBOX_EXPLORER_MAX_FILE_BYTES', 2 * 1024 * 1024),
    checkpointTimeoutMs: num('SANDBOX_CHECKPOINT_TIMEOUT_MS', 120_000),
    cpu: {
      thresholdPercent: num('SANDBOX_CPU_THRESHOLD_PCT', 90),
      samples: num('SANDBOX_CPU_SAMPLES', 5),
      stopAfterSamples: num('SANDBOX_CPU_STOP_AFTER_SAMPLES', 5),
      agentIdleMs: num('SANDBOX_CPU_AGENT_IDLE_MINUTES', 10) * 60_000,
    },
  });
  const adopted = await sandboxes.adopt();
  console.log(`[supervisor] adopted ${adopted} existing sandbox(es)`);
  sandboxes.startWatchdog(num('SANDBOX_WATCHDOG_INTERVAL_MS', 120_000));
  sandboxes.startCpuWatchdog(num('SANDBOX_CPU_INTERVAL_MS', 30_000));

  const app = createSupervisorApp(sandboxes, num('SANDBOX_DEFAULT_TIMEOUT_MS', 30_000));
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
