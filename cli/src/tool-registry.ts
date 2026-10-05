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

  /**
   * A new registry exposing only the named tools (same connections, same approval policy).
   * A name matches by exposed name ("server__tool"), label ("server/tool") or bare tool name.
   * Fail-closed: an empty/omitted list exposes NO tools — the model never even sees the
   * definitions it is not allowed to use, so there is nothing to bypass.
   */
  restrictTo(allow: readonly string[] | undefined): ToolRegistry {
    const sub = new ToolRegistry(this.autoApproveTools);
    const wanted = new Set(allow ?? []);
    for (const [key, tool] of this.tools) {
      if (wanted.has(tool.exposedName) || wanted.has(`${tool.connection.name}/${tool.realName}`) || wanted.has(tool.realName)) {
        sub.tools.set(key, tool);
      }
    }
    return sub;
  }

  /** Drops every tool of one connection (connector disabled/removed at runtime). */
  removeConnection(name: string): void {
    for (const [key, tool] of this.tools) if (tool.connection.name === name) this.tools.delete(key);
  }

  /** Exposed name for any accepted spelling ("server__tool", "server/tool", bare "tool"), or undefined. */
  resolveName(name: string): string | undefined {
    for (const tool of this.tools.values()) {
      if (name === tool.exposedName || name === `${tool.connection.name}/${tool.realName}` || name === tool.realName) return tool.exposedName;
    }
    return undefined;
  }

  toAnthropicTools(): AnthropicToolDef[] {
    return [...this.tools.values()].map(t => ({
      name: t.exposedName,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  has(exposedName: string): boolean {
    return this.tools.has(exposedName);
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
