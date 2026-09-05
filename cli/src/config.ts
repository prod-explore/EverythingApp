import 'dotenv/config';

export interface McpServerConfig {
  /** Short local name, used as a namespace prefix for tool routing (not sent to the model). */
  name: string;
  url: string;
  /** Bearer token, if the server requires auth (most do). */
  apiKey?: string;
}

export interface Config {
  anthropicApiKey: string;
  model: string;
  /** Tool names that never require interactive approval — everything else does. Default-deny by design (see README). */
  autoApproveTools: string[];
  /** If true, the Anthropic-hosted web_search tool is added alongside whatever MCP connectors are configured. */
  webSearchEnabled: boolean;
  mcpServers: McpServerConfig[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Connectors are entirely config-driven — adding one (GitHub's official remote
 * MCP server, n8n once it's deployed, a calendar MCP, whatever) never needs a
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
  // Read-only tools only. Anything not in this list requires a manual y/n in
  // the terminal — default-deny on purpose, see Master Brief §7 point 5
  // ("whitelist, never a bare shell"). Override via AUTO_APPROVE_TOOLS if a
  // newly-added connector has more read-only tools worth whitelisting.
  return ['read_log', 'get_path', 'search_notes'];
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
    anthropicApiKey: required('ANTHROPIC_API_KEY'),
    model: process.env['ANTHROPIC_MODEL'] ?? 'claude-sonnet-5',
    autoApproveTools: loadAutoApproveTools(),
    webSearchEnabled: process.env['WEB_SEARCH_ENABLED'] !== 'false',
    mcpServers,
  };
}
