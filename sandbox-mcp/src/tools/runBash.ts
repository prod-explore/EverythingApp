import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, fail, ToolContext } from './types.js';
import { checkApprovalGate } from '../approval.js';

export function registerRunBash(server: McpServer, { config, supervisor }: ToolContext): void {
  server.tool(
    'run_bash',
    'Execute a shell command inside the sandboxed container. ' +
      'All commands are logged to an append-only audit log. ' +
      'Requires approval before execution.',
    {
      command: z.string().describe('The shell command to run. Runs as: bash -c "<command>".'),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Execution timeout in milliseconds. Defaults to SANDBOX_TIMEOUT_MS env var.'),
    },
    async ({ command, timeout_ms }) => {
      const gate = checkApprovalGate('run_bash', config.autoApproveTools);
      if (gate.decision === 'deny') return fail(gate.reason);

      let containerId: string | null = null;
      try {
        const claimed = await supervisor.claim();
        containerId = claimed.containerId;

        const result = await supervisor.exec(
          containerId,
          command,
          timeout_ms ?? config.sandboxTimeoutMs,
        );

        const output = [
          result.stdout && `stdout:\n${result.stdout}`,
          result.stderr && `stderr:\n${result.stderr}`,
          `exit code: ${result.exitCode}`,
        ]
          .filter(Boolean)
          .join('\n');

        return result.exitCode === 0 ? ok(output) : fail(output);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(`run_bash error: ${message}`);
      } finally {
        if (containerId !== null) {
          supervisor.release(containerId).catch(err =>
            console.error('[run_bash] release error:', err),
          );
        }
      }
    },
  );
}
