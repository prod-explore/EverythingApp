import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PlaywrightConfig } from '../config.js';
import type { BrowserSessionPool } from '../sessionPool.js';
import { drainEvents } from '../browserContext.js';
import { normalizeHost } from '../policy.js';
import { observePage } from '../observe.js';
import { observationResult, UNTRUSTED_CONTENT_NOTICE } from './formatObservation.js';
import { applyCallPolicy, checkTargetUrl, effectivePolicy, hiddenPolicyArgs, withDownloadPermission } from './policyArgs.js';
import { fail } from './types.js';

/** The normalized host of `url` when it is exactly the host the orchestrator says the user approved. */
export function approvedHostFor(url: string, approvedHost: string | undefined): string | null {
  if (!approvedHost) return null;
  try {
    const host = normalizeHost(new URL(url).hostname);
    return host === normalizeHost(approvedHost) ? host : null;
  } catch {
    return null;
  }
}

export function registerBrowserOpen(server: McpServer, config: PlaywrightConfig, pool: BrowserSessionPool): void {
  server.tool(
    'browser_open',
    'Open (or reuse) this conversation\'s browser session and navigate to a URL. ' +
      'The session STAYS OPEN across calls — use browser_act to click/type/' +
      'select on the page afterward, and browser_close when you\'re done with it. ' +
      'The browser profile is ephemeral: no saved logins or cookies from earlier sessions; if a site ' +
      'needs a login, ask the user to log in via the live view. The user approves each website ' +
      '(domain) the first time you open it; a link or redirect to a DIFFERENT domain is blocked until you browser_open that URL, ' +
      'which asks the user. A domain the operator blocked stays blocked — tell the user instead of retrying. ' +
      'Returns a deterministic observation: the interactive element list (refs for browser_act) and ' +
      'the visible page text. ' +
      UNTRUSTED_CONTENT_NOTICE,
    {
      url: z.string().url().describe('The URL to navigate to. Must be http or https.'),
      _conversation_id: z
        .string()
        .optional()
        .describe('Internal: conversation ID for session isolation. Set by the orchestrator.'),
      ...hiddenPolicyArgs,
      _approved_host: z
        .string()
        .optional()
        .describe('Internal: the host the user just approved for this browser session. Set by the orchestrator, never by the model.'),
    },
    async ({ url, _conversation_id, _policy, _allow_downloads, _approved_host }) => {
      const convId = _conversation_id ?? 'default';
      const existing = pool.get(convId);
      const override = _policy ?? existing?.state.override;
      // The host the user approved on the card counts for this session (not just this call): the pages it links
      // to on the same host must stay reachable. It must be the host of the URL being opened, nothing wider.
      const approved = approvedHostFor(url, _approved_host);
      const preflight = new Set([...(existing?.state.approvedHosts ?? []), ...(approved ? [approved] : [])]);
      const policy = effectivePolicy(config, override, preflight);

      const blocked = await checkTargetUrl(config, policy, url);
      if (blocked) return fail(blocked);

      try {
        const notes: string[] = [];
        // JS on/off is fixed when a context is created — a changed JS policy needs a fresh session.
        if (existing && existing.state.policy.js !== policy.js) {
          await pool.close(convId, `JS policy changed (${existing.state.policy.js} → ${policy.js})`);
          notes.push(`(JS policy changed to "${policy.js}" — restarted the browser session)`);
        }
        const { session, isNew } = await pool.claim(convId, { policy, override });
        if (approved) session.state.approvedHosts.add(approved);
        applyCallPolicy(config, session.state, _policy);
        notes.unshift(
          isNew ? '(opened a new browser session for this conversation)' : '(reusing this conversation\'s existing browser session)',
        );

        return await withDownloadPermission(session.state, _allow_downloads, async () => {
          session.page.setDefaultTimeout(config.navTimeoutMs);
          try {
            await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
          } catch (err) {
            const events = drainEvents(session.state);
            const message = err instanceof Error ? err.message : String(err);
            return fail(`browser_open error: ${message}${events.length ? `\n${events.map(e => `- ${e}`).join('\n')}` : ''}`);
          }
          pool.setCurrentUrl(convId, session.page.url());
          const obs = await observePage(session.page, config, session.state.policy.js);
          return observationResult(obs, notes, drainEvents(session.state));
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(`browser_open error: ${message}`);
      }
    },
  );
}
