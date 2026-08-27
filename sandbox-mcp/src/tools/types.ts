import { Config } from '../config.js';
import { SupervisorClient } from '../supervisor-client.js';

/**
 * Standard MCP tool result shape returned by every tool handler.
 * The index signature matches the SDK's CallToolResult type.
 */
export interface ToolTextResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export function ok(text: string): ToolTextResult {
  return { content: [{ type: 'text', text }] };
}

export function fail(text: string): ToolTextResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Context every tool needs. */
export interface ToolContext {
  config: Config;
  supervisor: SupervisorClient;
}
