import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from './config.js';

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  text: string;
  isError: boolean;
}

/** What ToolRegistry actually depends on — lets tests pass a fake without a real transport. */
export interface McpConnectionLike {
  readonly name: string;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
}

/**
 * One connection to one MCP server (sandbox-mcp, obsidian-livesync-mcp, ...).
 * Thin wrapper — the SDK's Client already does the protocol work, this just
 * gives us a stable interface the rest of the CLI can depend on, and a place
 * to inject a fake in tests instead of hitting a real server.
 */
export class McpConnection {
  private client: Client | null = null;

  constructor(private readonly cfg: McpServerConfig) {}

  get name(): string {
    return this.cfg.name;
  }

  async connect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(this.cfg.url), {
      requestInit: this.cfg.apiKey
        ? { headers: { Authorization: `Bearer ${this.cfg.apiKey}` } }
        : undefined,
    });
    const client = new Client({ name: 'everythingapp-cli', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (!this.client) throw new Error(`MCP connection '${this.cfg.name}' is not connected`);
    const { tools } = await this.client.listTools();
    return tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (!this.client) throw new Error(`MCP connection '${this.cfg.name}' is not connected`);
    const result = await this.client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n');
    return { text: text || '(empty result)', isError: Boolean(result.isError) };
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.client = null;
  }
}
