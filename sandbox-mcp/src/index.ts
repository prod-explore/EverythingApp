import { loadConfig } from './config.js';
import { SupervisorClient } from './supervisor-client.js';
import { createApp } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const supervisor = new SupervisorClient(config.supervisorUrl);

  // Verify supervisor is reachable on startup — fail fast with a clear message
  // rather than discovering the problem on the first tool call.
  try {
    const health = await supervisor.health();
    console.log(`[sandbox-mcp] supervisor reachable — pool: ${JSON.stringify(health.pool)}`);
  } catch (err) {
    // Non-fatal: supervisor may still be starting up. We log a warning and proceed.
    // The first tool call will surface a clean error if it's still unreachable.
    console.warn('[sandbox-mcp] supervisor not yet reachable on startup:', err);
  }

  const app = createApp(config, supervisor);
  app.listen(config.mcpPort, '0.0.0.0', () => {
    console.log(`[sandbox-mcp] listening on port ${config.mcpPort}`);
  });
}

main().catch(err => {
  console.error('[sandbox-mcp] fatal startup error:', err);
  process.exit(1);
});
