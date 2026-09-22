import { loadConfig } from './config.js';
import { createApp } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config);

  app.listen(config.mcpPort, '0.0.0.0', () => {
    console.log(`[playwright-mcp] listening on port ${config.mcpPort}`);
    console.log(`[playwright-mcp] quarantine model: ${config.quarantineModel} @ ${config.quarantineModelUrl}`);
  });
}

main().catch(err => {
  console.error('[playwright-mcp] fatal startup error:', err);
  process.exit(1);
});
