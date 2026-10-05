import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, fail, ownerIds, ownerOf, ToolContext } from './types.js';

export function registerReadLog(server: McpServer, { supervisor }: ToolContext): void {
  server.tool(
    'read_log',
    'Read the append-only action log from the sandbox. ' +
      'Every command executed via run_bash or git_op is recorded here with a timestamp. ' +
      'Use this to audit what the agent has done in the current session. ' +
      'This tool is read-only and does not require approval.',
    {
      lines: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe('Number of most recent log lines to return. Defaults to 50, max 500.'),
      ...ownerIds,
    },
    async ({ lines = 50, ...ids }) => {
      try {
        const claimed = await supervisor.claim(ownerOf(ids));

        const result = await supervisor.exec(
          claimed.containerId,
          `tail -n ${lines} /var/log/sandbox-actions.log`,
          5_000,
        );

        const content = result.stdout.trim();
        return ok(content || '(action log is empty)');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(`read_log error: ${message}`);
      }
    },
  );
}
