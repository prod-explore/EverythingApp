import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlaywrightConfig } from '../config.js';
import type { BrowserSessionPool } from '../sessionPool.js';
import { registerBrowseUrl } from './browseUrl.js';
import { registerBrowserOpen } from './browserOpen.js';
import { registerBrowserObserve } from './browserObserve.js';
import { registerBrowserAct } from './browserAct.js';
import { registerBrowserClose } from './browserClose.js';

export function registerAllTools(server: McpServer, config: PlaywrightConfig, pool: BrowserSessionPool): void {
  // One-shot, no session — still the right tool for "get me one fact from a page".
  registerBrowseUrl(server, config);
  // Multi-step, session-based — for tasks that need to click/type/navigate (§6b).
  registerBrowserOpen(server, config, pool);
  registerBrowserObserve(server, config, pool);
  registerBrowserAct(server, config, pool);
  registerBrowserClose(server, pool);
}
