import 'dotenv/config';

export interface McpServerConfig {
  /** Short local name, used as a namespace prefix for tool routing (not sent to the model). */
  name: string;
  url: string;
  /** Bearer token, if the server requires auth (most do). */
  apiKey?: string;
}

export interface Config {
  /** Last-resort model id (`@provider/model`) for chats that have none and when no usable free model exists. Usually empty: providers and slots are configured in Settings → Models. */
  model: string;
  /** Tool names that never require interactive approval — everything else does. Default-deny by design (see README). */
  autoApproveTools: string[];
  mcpServers: McpServerConfig[];
}

/**
 * Connectors are entirely config-driven — adding one (GitHub's official remote
 * MCP server, a workflow engine, a calendar MCP, whatever) never needs a
 * code change here, only a new name in MCP_CONNECTORS plus its URL/key pair.
 *
 * MCP_CONNECTORS=sandbox,obsidian,github
 * MCP_SANDBOX_URL=...        MCP_SANDBOX_API_KEY=...
 * MCP_OBSIDIAN_URL=...       MCP_OBSIDIAN_API_KEY=...
 * MCP_GITHUB_URL=...         MCP_GITHUB_API_KEY=...
 */
function loadMcpServers(): McpServerConfig[] {
  const names = (process.env['MCP_CONNECTORS'] ?? '')
    .split(',')
    .map(n => n.trim())
    .filter(Boolean);

  const servers: McpServerConfig[] = [];
  for (const name of names) {
    const envPrefix = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const url = process.env[`MCP_${envPrefix}_URL`];
    if (!url) {
      console.warn(`[config] MCP_CONNECTORS lists '${name}' but MCP_${envPrefix}_URL is unset — skipping it.`);
      continue;
    }
    servers.push({ name, url, apiKey: process.env[`MCP_${envPrefix}_API_KEY`] });
  }
  return servers;
}

function loadAutoApproveTools(): string[] {
  const fromEnv = process.env['AUTO_APPROVE_TOOLS'];
  if (fromEnv) {
    return fromEnv.split(',').map(t => t.trim()).filter(Boolean);
  }
  // Default-deny on purpose, see Master Brief §7 point 5 ("whitelist, never a bare shell"): a tool that is not in this
  // list asks for a manual approval. Override via AUTO_APPROVE_TOOLS (the variable REPLACES this list).
  // Browser: opening a page is approved per DOMAIN in the orchestrator (llm-loop: Allow once / this chat / always), so
  // browser_open needs no second prompt; browser_act runs unprompted inside the approved domain, except actions that
  // look irreversible (payment, deletion…), which always ask; after a page looked like a prompt injection every
  // effectful call asks again.
  return ['read_log', 'get_path', 'search_notes', 'browser_open', 'browser_observe', 'browser_act', 'browser_close'];
}

export function loadConfig(): Config {
  const mcpServers = loadMcpServers();

  if (mcpServers.length === 0) {
    console.warn(
      '[config] No MCP connectors configured (MCP_CONNECTORS is empty/unset). ' +
        'The CLI will still work as a plain chat, just without those tools.',
    );
  }

  return {
    model: process.env['DEFAULT_MODEL'] ?? '',
    autoApproveTools: loadAutoApproveTools(),
    mcpServers,
  };
}
