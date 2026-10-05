import { z } from 'zod';
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

/** Injected by the orchestrator, never supplied by the model. Spread into every tool's input schema. */
export const ownerIds = {
  _conversation_id: z.string().optional().describe('Internal: set by the orchestrator.'),
  _project_id: z.string().optional().describe('Internal: set by the orchestrator when the chat belongs to a project.'),
};

/** Whose sandbox: the project's if the chat is in one (shared by all its chats), else the chat's own. */
export function ownerOf(args: { _conversation_id?: string; _project_id?: string }): string {
  return args._project_id ?? args._conversation_id ?? 'default';
}

export const MAX_COMMAND_MS = 280_000;
