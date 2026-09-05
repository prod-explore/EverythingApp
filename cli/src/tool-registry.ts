import type { McpConnectionLike, McpToolCallResult } from './mcp-client.js';

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface RegisteredTool {
  /** Name exposed to the model — "<server>__<tool>", to keep servers from colliding. */
  exposedName: string;
  /** Real tool name as understood by the owning MCP server. */
  realName: string;
  connection: McpConnectionLike;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Aggregates every tool from every connected MCP server into one flat list
 * for the model, and routes tool_use calls back to whichever server actually
 * owns that tool. Also the single place that decides whether a call needs a
 * human's yes/no before it runs.
 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  constructor(private readonly autoApproveTools: readonly string[]) {}

  async loadFrom(connections: McpConnectionLike[]): Promise<void> {
    for (const connection of connections) {
      const list = await connection.listTools();
      for (const tool of list) {
        const exposedName = `${connection.name}__${tool.name}`;
        this.tools.set(exposedName, {
          exposedName,
          realName: tool.name,
          connection,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
  }

  toAnthropicTools(): AnthropicToolDef[] {
    return [...this.tools.values()].map(t => ({
      name: t.exposedName,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  /** Default-deny: a tool is auto-approved only if explicitly whitelisted by its real (unprefixed) name. */
  requiresApproval(exposedName: string): boolean {
    const tool = this.tools.get(exposedName);
    const realName = tool?.realName ?? exposedName;
    return !this.autoApproveTools.includes(realName);
  }

  describe(exposedName: string): string {
    const tool = this.tools.get(exposedName);
    return tool ? `${tool.connection.name}/${tool.realName}` : exposedName;
  }

  async call(exposedName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const tool = this.tools.get(exposedName);
    if (!tool) {
      return { text: `Unknown tool: ${exposedName}`, isError: true };
    }
    return tool.connection.callTool(tool.realName, args);
  }
}
