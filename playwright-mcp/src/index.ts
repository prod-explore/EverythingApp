import * as http from 'node:http';
import { loadConfig } from './config.js';
import { createApp } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, attachLiveViewToServer } = createApp(config);

  // Use a raw http.Server so the WebSocket upgrade handler for /mcp/liveview
  // can share the same port as the Express MCP routes.
  const server = http.createServer(app);
  attachLiveViewToServer(server);

  server.listen(config.mcpPort, '0.0.0.0', () => {
    console.log(`[playwright-mcp] listening on port ${config.mcpPort}`);
    console.log(`[playwright-mcp] quarantine model: ${config.quarantineModel} @ ${config.quarantineModelUrl}`);
    console.log(`[playwright-mcp] live-view WS available at ws://...:${config.mcpPort}/mcp/liveview?conversationId=<id>&token=<token>`);
  });
}

main().catch(err => {
  console.error('[playwright-mcp] fatal startup error:', err);
  process.exit(1);
});
