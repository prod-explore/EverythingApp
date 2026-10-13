import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from './config.js';

const envTimeout = parseInt(process.env['MCP_TOOL_TIMEOUT_MS'] ?? '', 10);
const TOOL_CALL_TIMEOUT_MS = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 330_000;

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
  /** False = the connection is down (never connected, or lost). Unset = assume up. */
  readonly connected?: boolean;
  /**
   * Configured by the operator (env), as opposed to added by hand in Settings. Only trusted connections can have
   * tools auto-approved by name (AUTO_APPROVE_TOOLS); tools of any other connector ask until the user grants them.
   * Unset = trusted.
   */
  readonly trusted?: boolean;
  /** Endpoint, for display. */
  readonly url?: string;
  /** Why the last connection attempt failed (cleared on success). */
  readonly lastError?: string;
  /** (Re)establishes the connection. */
  connect?(): Promise<void>;
  /** The name the server reports about itself, once connected. */
  readonly serverName?: string;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
}

/**
 * One connection to one MCP server (sandbox, GitHub, a notes server, ...).
 * Thin wrapper — the SDK's Client already does the protocol work, this just
 * gives us a stable interface the rest of the CLI can depend on, and a place
 * to inject a fake in tests instead of hitting a real server.
 */
export class McpConnection implements McpConnectionLike {
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  lastError: string | undefined;

  /** `trusted`: see McpConnectionLike. Env connectors are trusted, connectors added in Settings are not. */
  constructor(private readonly cfg: McpServerConfig, readonly trusted: boolean = true) {}

  get name(): string {
    return this.cfg.name;
  }

  get url(): string {
    return this.cfg.url;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  /** Name the server reports about itself (used to suggest a connector name). */
  get serverName(): string | undefined {
    return this.client?.getServerVersion()?.name;
  }

  /**
   * MCP servers speak one of two HTTP flavours: Streamable HTTP (current) or the older HTTP+SSE transport
   * (`GET /sse` + `POST /messages`). The path says nothing reliable
   * (some Streamable servers are mounted under `/mcp/sse` too), so Streamable HTTP is always tried first —
   * a legacy server rejects its POST outright — and the SSE transport is the fallback.
   */
  connect(): Promise<void> {
    // One attempt at a time: a reconnect triggered by a failed call must not race the one already running.
    this.connecting ??= this.doConnect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.client = null;
    const url = new URL(this.cfg.url);
    const requestInit: RequestInit | undefined = this.cfg.apiKey ? { headers: { Authorization: `Bearer ${this.cfg.apiKey}` } } : undefined;
    const streamable = (): Transport => new StreamableHTTPClientTransport(url, { requestInit });
    const sse = (): Transport => new SSEClientTransport(url, { requestInit });
    let firstError: unknown;
    for (const make of [streamable, sse]) {
      const client = new Client({ name: 'everythingapp-cli', version: '0.1.0' }, { capabilities: {} });
      try {
        client.onclose = () => { if (this.client === client) this.client = null; };
        await client.connect(make());
        this.client = client;
        this.lastError = undefined;
        return;
      } catch (err) {
        firstError ??= err;
        await client.close().catch(() => {});
      }
    }
    const failure = firstError instanceof Error ? firstError : new Error(`could not connect to MCP server '${this.cfg.name}'`);
    this.lastError = failure.message.slice(0, 300);
    throw failure;
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (!this.client) throw new Error(`MCP connection '${this.cfg.name}' is not connected`);
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) out.push({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema as Record<string, unknown> });
      cursor = page.nextCursor;
    } while (cursor && out.length < 1000);
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    try {
      return await this.callOnce(name, args);
    } catch (err) {
      // The server restarted or the session expired: the request never ran, so connecting again and repeating it is safe.
      // Anything else (a timeout, a connection cut mid-call) may have run already and is reported as it is.
      if (!isSessionLost(err)) throw err;
      await this.connect();
      return this.callOnce(name, args);
    }
  }

  private async callOnce(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (!this.client) await this.connect();
    // The SDK's default request timeout is 60s, which would cut off a long `npm install` that the sandbox
    // itself is still happily running. Sandbox commands cap at 280s; leave headroom above that.
    const result = await this.client!.callTool({ name, arguments: args }, undefined, { timeout: TOOL_CALL_TIMEOUT_MS });
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

/** Errors that mean "no session on the server (any more)" — the call was rejected before it ran. */
export function isSessionLost(err: unknown): boolean {
  const m = err instanceof Error ? `${err.message} ${(err.cause as Error | undefined)?.message ?? ''}` : String(err);
  return /session not found|no valid session|not connected|ECONNREFUSED|HTTP 404/i.test(m);
}
