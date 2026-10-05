import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, fail, ownerIds, ownerOf, ToolContext } from './types.js';
import { checkApprovalGate } from '../approval.js';
import type { CheckpointInfo } from '../supervisor-client.js';

/** Pure formatter for checkpoint_list, testable without a server. */
export function formatCheckpoints(list: CheckpointInfo[]): string {
  if (list.length === 0) return 'No checkpoints yet. One is taken automatically before each agent turn.';
  return list.map(c => `${c.id}  ${c.createdAt}  ${c.label || '(no label)'}`).join('\n');
}

/**
 * Checkpoints are taken by the orchestrator before every agent turn (POST /sandboxes/:owner/checkpoint);
 * the agent can list them and, with approval, roll the workspace back to one.
 */
export function registerCheckpointTools(server: McpServer, { config, supervisor }: ToolContext): void {
  server.tool(
    'checkpoint_list',
    'List the automatic checkpoints of /workspace (one is taken before each agent turn), newest first: id, time and label. ' +
      'Read-only. Use an id with the rollback tool to undo changes.',
    { ...ownerIds },
    async args => {
      try {
        return ok(formatCheckpoints(await supervisor.listCheckpoints(ownerOf(args))));
      } catch (err: unknown) {
        return fail(`checkpoint_list error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'rollback',
    'Restore /workspace to a checkpoint from checkpoint_list: tracked files are reset to that state and files created since ' +
      '(that are not git-ignored) are deleted. Ignored files (e.g. node_modules) and any .git directory are left alone. ' +
      'Later checkpoints stay available, so a rollback can itself be undone. Fails while a command is still running. ' +
      'Requires approval.',
    {
      checkpoint_id: z
        .string()
        .regex(/^[a-z0-9]{1,16}-[a-f0-9]{4,16}$/)
        .describe('Checkpoint id from checkpoint_list.'),
      ...ownerIds,
    },
    async args => {
      const gate = checkApprovalGate('rollback', config.autoApproveTools);
      if (gate.decision === 'deny') return fail(gate.reason);
      try {
        const r = await supervisor.rollback(ownerOf(args), args.checkpoint_id);
        return ok(`Workspace restored to checkpoint ${r.checkpointId} (commit ${r.commit.slice(0, 12)}).`);
      } catch (err: unknown) {
        return fail(`rollback error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
