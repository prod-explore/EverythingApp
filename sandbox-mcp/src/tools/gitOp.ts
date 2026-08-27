import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, fail, ToolContext } from './types.js';
import { checkApprovalGate } from '../approval.js';

// Whitelist: only subcommands useful for coding agent work.
// Destructive operations (rm, clean, reset --hard) are deliberately excluded.
// If a user needs those, they should use run_bash with explicit intent so the
// approval gate shows the full command.
const ALLOWED_SUBCOMMANDS = [
  'clone',
  'status',
  'diff',
  'log',
  'add',
  'commit',
  'push',
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
      'Destructive subcommands (rm, clean, reset --hard) are not available — use run_bash for those with explicit intent. ' +
      'Requires approval before execution.',
    {
      subcommand: z
        .enum(ALLOWED_SUBCOMMANDS)
        .describe('The git subcommand to run.'),
      args: z
        .array(z.string())
        .optional()
        .describe('Additional arguments (e.g. ["-m", "my commit message"]).'),
    },
    async ({ subcommand, args = [] }: { subcommand: GitSubcommand; args?: string[] }) => {
      const gate = checkApprovalGate('git_op', config.autoApproveTools);
      if (gate.decision === 'deny') return fail(gate.reason);

      // Shell-escape each argument to prevent injection via args array.
      const escapedArgs = [subcommand, ...args]
        .map(arg => `'${arg.replace(/'/g, "'\\''")}'`)
        .join(' ');
      const command = `git ${escapedArgs}`;

      let containerId: string | null = null;
      try {
        const claimed = await supervisor.claim();
        containerId = claimed.containerId;

        const result = await supervisor.exec(containerId, command, config.sandboxTimeoutMs);

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
      } finally {
        if (containerId !== null) {
          supervisor.release(containerId).catch(err =>
            console.error('[git_op] release error:', err),
          );
        }
      }
    },
  );
}
