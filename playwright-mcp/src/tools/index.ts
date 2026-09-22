import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlaywrightConfig } from '../config.js';
import { registerBrowseUrl } from './browseUrl.js';

export function registerAllTools(server: McpServer, config: PlaywrightConfig): void {
  registerBrowseUrl(server, config);
}
