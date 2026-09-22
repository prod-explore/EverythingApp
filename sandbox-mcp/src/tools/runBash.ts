import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, fail, ToolContext } from './types.js';
import { checkApprovalGate } from '../approval.js';

export function registerRunBash(server: McpServer, { config, supervisor }: ToolContext): void {
  server.tool(
    'run_bash',
    'Execute a shell command inside the sandboxed container. ' +
      'All commands are logged to an append-only audit log. ' +
      'Requires approval before execution. ' +
      'Files created in /workspace persist across tool calls within the same conversation.',
    {
      command: z.string().describe('The shell command to run. Runs as: bash -c "<command>".'),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Execution timeout in milliseconds. Defaults to SANDBOX_TIMEOUT_MS env var.'),
      // Injected by the orchestrator — not intended for the model to supply.
      _conversation_id: z
        .string()
        .optional()
        .describe('Internal: conversation ID for workspace isolation. Set by the orchestrator.'),
    },
    async ({ command, timeout_ms, _conversation_id }) => {
      const gate = checkApprovalGate('run_bash', config.autoApproveTools);
      if (gate.decision === 'deny') return fail(gate.reason);

      const convId = _conversation_id ?? 'default';

      let containerId: string | null = null;
      try {
        const claimed = await supervisor.claim(convId);
        containerId = claimed.containerId;

        // Run commands in the conversation's workspace subdirectory.
        const wrappedCommand = `cd ${claimed.workspacePath} && (${command})`;

        const result = await supervisor.exec(
          containerId,
          wrappedCommand,
          timeout_ms ?? config.sandboxTimeoutMs,
          convId,
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
      }
      // Note: no release here — sticky leases persist until idle timeout or explicit release.
      // The container is reused for the next tool call in the same conversation.
    },
  );
}
