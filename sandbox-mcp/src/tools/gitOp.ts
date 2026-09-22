import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, fail, ToolContext } from './types.js';
import { checkApprovalGate } from '../approval.js';

// Whitelist: only subcommands useful for coding agent work.
// `push` is deliberately excluded — use the GitHub connector (github-mcp-server)
// to push changes. This keeps git credentials out of the sandbox entirely.
const ALLOWED_SUBCOMMANDS = [
  'clone',
  'status',
  'diff',
  'log',
  'add',
  'commit',
  'pull',
  'fetch',
  'checkout',
  'branch',
  'stash',
  'show',
] as const;

type GitSubcommand = (typeof ALLOWED_SUBCOMMANDS)[number];

export function registerGitOp(server: McpServer, { config, supervisor }: ToolContext): void {
  server.tool(
    'git_op',
    'Run a whitelisted git command inside the sandboxed container. ' +
      `Allowed subcommands: ${ALLOWED_SUBCOMMANDS.join(', ')}. ` +
      'To push changes to GitHub, use the GitHub connector (github__push_files or github__create_or_update_file) — ' +
      'git push is not available in the sandbox to keep credentials out of the sandbox environment. ' +
      'Requires approval before execution.',
    {
      subcommand: z
        .enum(ALLOWED_SUBCOMMANDS)
        .describe('The git subcommand to run.'),
      args: z
        .array(z.string())
        .optional()
        .describe('Additional arguments (e.g. ["-m", "my commit message"]).'),
      // Injected by the orchestrator — not intended for the model to supply.
      _conversation_id: z
        .string()
        .optional()
        .describe('Internal: conversation ID for workspace isolation. Set by the orchestrator.'),
    },
    async ({ subcommand, args = [], _conversation_id }: { subcommand: GitSubcommand; args?: string[]; _conversation_id?: string }) => {
      const gate = checkApprovalGate('git_op', config.autoApproveTools);
      if (gate.decision === 'deny') return fail(gate.reason);

      const convId = _conversation_id ?? 'default';

      // Shell-escape each argument to prevent injection via args array.
      const escapedArgs = [subcommand, ...args]
        .map(arg => `'${arg.replace(/'/g, "'\\''")}'`)
        .join(' ');

      let containerId: string | null = null;
      try {
        const claimed = await supervisor.claim(convId);
        containerId = claimed.containerId;

        // Run git in the conversation's workspace subdirectory.
        const command = `cd ${claimed.workspacePath} && git ${escapedArgs}`;

        const result = await supervisor.exec(containerId, command, config.sandboxTimeoutMs, convId);

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
        return fail(`git_op error: ${message}`);
      }
      // Note: no release here — sticky leases persist until idle timeout.
    },
  );
}
