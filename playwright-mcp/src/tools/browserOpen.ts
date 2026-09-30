import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PlaywrightConfig } from '../config.js';
import type { BrowserSessionPool } from '../sessionPool.js';
import { UrlBlockedError } from '../urlSafety.js';
import { guardFor } from '../urlGuardFor.js';
import { observePage } from '../observe.js';
import { formatObservation } from './formatObservation.js';
import { ok, fail } from './types.js';

export function registerBrowserOpen(server: McpServer, config: PlaywrightConfig, pool: BrowserSessionPool): void {
  server.tool(
    'browser_open',
    'Open (or reuse) this conversation\'s browser session and navigate to a URL. ' +
      'Unlike browse_url, the session STAYS OPEN across calls — use browser_act to click/type/' +
      'select on the page afterward, and browser_close when you\'re done with it. ' +
      'Login sessions persist across calls (and across separate conversations reusing the same ' +
      'session), so a site you\'ve logged into before should already be authenticated. ' +
      'Returns a quarantined observation of the page — raw HTML/DOM never reaches you.',
    {
      url: z.string().url().describe('The URL to navigate to. Must be http or https.'),
      _conversation_id: z
        .string()
        .optional()
        .describe('Internal: conversation ID for session isolation. Set by the orchestrator.'),
    },
    async ({ url, _conversation_id }) => {
      try {
        await guardFor(config).check(url);
      } catch (err) {
        if (err instanceof UrlBlockedError) return fail(`Error: ${err.message}`);
        throw err;
      }

      const convId = _conversation_id ?? 'default';

      try {
        const { session, isNew } = await pool.claim(convId);
        session.page.setDefaultTimeout(config.navTimeoutMs);
        await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
        pool.setCurrentUrl(convId, url);

        const obs = await observePage(session.page, config);
        return ok(
          formatObservation(
            obs,
            isNew
              ? '(opened a new browser session for this conversation)'
              : '(reusing this conversation\'s existing browser session)',
          ),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(`browser_open error: ${message}`);
      }
    },
  );
}
