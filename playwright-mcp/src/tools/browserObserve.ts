import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PlaywrightConfig } from '../config.js';
import type { BrowserSessionPool } from '../sessionPool.js';
import { drainEvents } from '../browserContext.js';
import { observePage } from '../observe.js';
import { observationResult, UNTRUSTED_CONTENT_NOTICE } from './formatObservation.js';
import { applyCallPolicy, hiddenPolicyArgs } from './policyArgs.js';
import { fail } from './types.js';

export function registerBrowserObserve(server: McpServer, config: PlaywrightConfig, pool: BrowserSessionPool): void {
  server.tool(
    'browser_observe',
    'Re-observe the current state of this conversation\'s open browser session — the page as it ' +
      'is right now, without navigating or acting. Use this after an action might have changed the ' +
      'page in a way you want to re-check, or if you\'re not sure your last observation is still ' +
      'accurate. Fails if no session is open yet — call browser_open first. Read-only, no side effects. ' +
      UNTRUSTED_CONTENT_NOTICE,
    {
      _conversation_id: z
        .string()
        .optional()
        .describe('Internal: conversation ID for session isolation. Set by the orchestrator.'),
      ...hiddenPolicyArgs,
    },
    async ({ _conversation_id, _policy }) => {
      const convId = _conversation_id ?? 'default';
      const session = pool.get(convId);
      if (!session) {
        return fail('No open browser session for this conversation — call browser_open with a URL first.');
      }

      try {
        pool.touch(convId);
        applyCallPolicy(config, session.state, _policy);
        const obs = await observePage(session.page, config, session.state.policy.js);
        return observationResult(obs, [], drainEvents(session.state));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(`browser_observe error: ${message}`);
      }
    },
  );
}
