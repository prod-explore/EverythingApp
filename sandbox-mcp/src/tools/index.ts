import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Config } from '../config.js';
import { SupervisorClient } from '../supervisor-client.js';
import { registerRunBash } from './runBash.js';
import { registerGitOp } from './gitOp.js';
import { registerReadLog } from './readLog.js';

/** Registers every tool this server exposes onto a fresh McpServer instance. */
export function registerAllTools(
  server: McpServer,
  config: Config,
  supervisor: SupervisorClient,
): void {
  const ctx = { config, supervisor };
  registerRunBash(server, ctx);
  registerGitOp(server, ctx);
  registerReadLog(server, ctx);
}
