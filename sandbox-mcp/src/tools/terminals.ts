import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, fail, ownerIds, ownerOf, ToolContext } from './types.js';

export function registerTerminalTools(server: McpServer, { supervisor }: ToolContext): void {
  server.tool(
    'terminal_list',
    'List the open terminals of this project sandbox, whether each is busy, and how long it has been idle. ' +
      'Idle terminals are closed automatically; the workspace files are never affected. Read-only.',
    { ...ownerIds },
    async args => {
      try {
        const terminals = await supervisor.listTerminals(ownerOf(args));
        if (terminals.length === 0) return ok('No open terminals. run_bash opens one on demand.');
        return ok(
          terminals
            .map(t => `${t.name}: ${t.busy ? 'running a command' : `idle ${Math.round(t.idleMs / 1000)}s`}, open ${Math.round(t.ageMs / 1000)}s`)
            .join('\n'),
        );
      } catch (err: unknown) {
        return fail(`terminal_list error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'terminal_close',
    'Close a terminal and kill everything running in it (background jobs included). Files in /workspace are untouched.',
    {
      terminal: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).describe('Name of the terminal to close.'),
      ...ownerIds,
    },
    async args => {
      try {
        const closed = await supervisor.closeTerminal(ownerOf(args), args.terminal);
        return closed ? ok(`Terminal "${args.terminal}" closed.`) : fail(`No open terminal named "${args.terminal}".`);
      } catch (err: unknown) {
        return fail(`terminal_close error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
