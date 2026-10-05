import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, fail, ownerIds, ownerOf, MAX_COMMAND_MS, ToolContext } from './types.js';
import { checkApprovalGate } from '../approval.js';
import type { TerminalRunResult } from '../supervisor-client.js';

/** Turns a supervisor result into the text the model sees. Pure, so it can be tested without a server. */
export function formatRunResult(r: TerminalRunResult, timeoutMs: number): { text: string; isError: boolean } {
  const lines = [r.output.replace(/\n$/, '')];
  if (r.timedOut) {
    lines.push(
      `[timed out after ${timeoutMs}ms — terminal "${r.terminal}" was killed, so its working directory and variables are reset. ` +
        'Run long jobs in the background (nohup … &) and poll their log.]',
    );
  } else if (r.terminalClosed) {
    lines.push(`[terminal "${r.terminal}" ended (the shell exited); the next command opens a fresh one]`);
  }
  if (r.exitCode !== null) lines.push(`exit code: ${r.exitCode}`);
  return { text: lines.filter(l => l !== '').join('\n'), isError: r.exitCode !== 0 };
}

export function registerRunBash(server: McpServer, { config, supervisor }: ToolContext): void {
  server.tool(
    'run_bash',
    'Run a shell command in a persistent terminal inside the project sandbox. ' +
      'A terminal is a long-lived bash: the working directory, exported variables and shell functions carry over to the next command ' +
      'in the same terminal. Use separate named terminals for separate jobs (e.g. "dev", "tests"); the default is "main". ' +
      'stdout and stderr are merged. The sandbox has internet access and /workspace persists across chats, restarts and idle periods ' +
      '(everything else is read-only or temporary: /tmp and $HOME are wiped when the sandbox stops; you are not root, so apt and global installs are unavailable — install project-locally). ' +
      `A command is limited to ${Math.round(MAX_COMMAND_MS / 1000)}s; if it times out the terminal is killed. ` +
      'For long-running processes (dev servers, builds, watchers) start them in the background, e.g. `nohup npm run dev > dev.log 2>&1 &`, ' +
      'and check on them with `tail dev.log`. Stdin is not available: commands cannot prompt for input. ' +
      'Requires approval before execution; every command is logged.',
    {
      command: z.string().describe('The shell command to run (any bash, multi-line allowed).'),
      terminal: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,32}$/)
        .optional()
        .describe('Terminal name. Defaults to "main". A new name opens a new terminal (max 4 per sandbox).'),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_COMMAND_MS)
        .optional()
        .describe('Execution timeout in milliseconds. Defaults to the server setting.'),
      ...ownerIds,
    },
    async args => {
      const gate = checkApprovalGate('run_bash', config.autoApproveTools);
      if (gate.decision === 'deny') return fail(gate.reason);

      const timeoutMs = Math.min(args.timeout_ms ?? config.sandboxTimeoutMs, MAX_COMMAND_MS);
      try {
        const r = await supervisor.runInTerminal(ownerOf(args), args.terminal, args.command, timeoutMs);

        const { text, isError } = formatRunResult(r, timeoutMs);
        return isError ? fail(text) : ok(text);
      } catch (err: unknown) {
        return fail(`run_bash error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
