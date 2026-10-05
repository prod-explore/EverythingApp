import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PlaywrightConfig } from '../config.js';
import type { BrowserSessionPool } from '../sessionPool.js';
import { drainEvents } from '../browserContext.js';
import { observePage } from '../observe.js';
import { observationResult, UNTRUSTED_CONTENT_NOTICE } from './formatObservation.js';
import { applyCallPolicy, checkTargetUrl, hiddenPolicyArgs, withDownloadPermission } from './policyArgs.js';
import { fail } from './types.js';

const ACTIONS = ['click', 'type', 'select', 'press', 'navigate'] as const;
type Action = (typeof ACTIONS)[number];

export function registerBrowserAct(server: McpServer, config: PlaywrightConfig, pool: BrowserSessionPool): void {
  server.tool(
    'browser_act',
    'Perform ONE action on this conversation\'s open browser session, then return the resulting ' +
      'page observation. Actions: "click" a ref, "type" a value into a ref, "select" an option in ' +
      'a ref (dropdown), "press" a key (e.g. "Enter") either globally or focused on a ref, or ' +
      '"navigate" to a new URL (value = the URL). `ref` numbers come from the [N] markers in the ' +
      'last observation you received — always re-observe with browser_observe first if you\'re not ' +
      'sure the page hasn\'t changed since. `label` is REQUIRED and must be copied from that same ' +
      'observation line (e.g. the text after the [ref] in `[3] button: "Delete Account"` is ' +
      '`Delete Account`) — it\'s shown to the human if this action needs their approval, so a vague ' +
      'or missing label makes that approval prompt useless to them. Downloads and file uploads are ' +
      'blocked unless the user allowed them; navigations to domains outside the project policy fail. ' +
      UNTRUSTED_CONTENT_NOTICE,
    {
      action: z.enum(ACTIONS).describe('Which kind of action to perform.'),
      ref: z
        .number()
        .int()
        .optional()
        .describe('The [ref] number from the last observation. Required for click/type/select; optional for press; unused for navigate.'),
      value: z
        .string()
        .optional()
        .describe('For "type": the text to enter. For "select": the option to choose. For "press": the key name (e.g. "Enter", "Tab"). For "navigate": the URL.'),
      label: z
        .string()
        .min(1)
        .describe(
          'Human-readable description of the target, copied from the observation line for this ref ' +
            '(e.g. "Delete Account" button, "Email address" field). Required for every action — this is ' +
            'what a human reviewing an approval prompt for this action actually sees.',
        ),
      _conversation_id: z
        .string()
        .optional()
        .describe('Internal: conversation ID for session isolation. Set by the orchestrator.'),
      ...hiddenPolicyArgs,
    },
    async ({ action, ref, value, label, _conversation_id, _policy, _allow_downloads }) => {
      const convId = _conversation_id ?? 'default';
      const session = pool.get(convId);
      if (!session) {
        return fail('No open browser session for this conversation — call browser_open with a URL first.');
      }

      const invalid = validateArgs(action, ref, value);
      if (invalid) return fail(invalid);

      pool.touch(convId);
      const { page, state } = session;
      applyCallPolicy(config, state, _policy);

      try {
        return await withDownloadPermission(state, _allow_downloads, async () => {
          if (action === 'navigate') {
            const blocked = await checkTargetUrl(config, state.policy, value!);
            if (blocked) return fail(blocked);
            await page.goto(value!, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
            pool.setCurrentUrl(convId, value!);
          } else if (action === 'press' && ref === undefined) {
            await page.keyboard.press(value!);
          } else {
            const locator = page.locator(`[data-ea-ref="${ref}"]`);
            const count = await locator.count();
            if (count === 0) {
              return fail(
                `Ref [${ref}] not found on the current page — it may be stale (the page changed since ` +
                  `your last observation). Call browser_observe to get current refs, then retry.`,
              );
            }
            switch (action) {
              case 'click':
                await locator.first().click({ timeout: config.navTimeoutMs });
                break;
              case 'type':
                await locator.first().fill(value ?? '', { timeout: config.navTimeoutMs });
                break;
              case 'select':
                await locator.first().selectOption(value ?? '', { timeout: config.navTimeoutMs });
                break;
              case 'press':
                await locator.first().press(value!, { timeout: config.navTimeoutMs });
                break;
            }
            pool.setCurrentUrl(convId, page.url());
          }

          // Best-effort settle — SPAs that never go network-idle shouldn't fail the action.
          await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

          const obs = await observePage(page, config, state.policy.js);
          return observationResult(
            obs,
            [`(performed: ${action} on ${JSON.stringify(label)}${value ? ` = ${JSON.stringify(value)}` : ''})`],
            drainEvents(state),
          );
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const events = drainEvents(state);
        return fail(
          `browser_act error performing "${action}" on "${label}": ${message}` +
            (events.length ? '\n' + events.map(e => `- ${e}`).join('\n') : ''),
        );
      }
    },
  );
}

function validateArgs(action: Action, ref: number | undefined, value: string | undefined): string | null {
  if ((action === 'click' || action === 'type' || action === 'select') && ref === undefined) {
    return `Action "${action}" requires a ref.`;
  }
  if (action === 'type' && value === undefined) {
    return 'Action "type" requires a value.';
  }
  if (action === 'select' && value === undefined) {
    return 'Action "select" requires a value.';
  }
  if (action === 'press' && !value) {
    return 'Action "press" requires a value (the key name, e.g. "Enter").';
  }
  if (action === 'navigate' && !value) {
    return 'Action "navigate" requires a value (the URL).';
  }
  return null;
}
