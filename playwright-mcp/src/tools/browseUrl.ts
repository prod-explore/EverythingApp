import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PlaywrightConfig } from '../config.js';
import { drainEvents, launchHardenedContext, newSessionState, type HardenedContext } from '../browserContext.js';
import { scoreInjection } from '../injection.js';
import { buildObservation, capturePage, wrapUntrusted, type Observation } from '../observe.js';
import { extractWithQuarantine, type QuarantineExtraction } from '../quarantine.js';
import { guardFor } from '../urlGuardFor.js';
import { eventsBlock, injectionHeader, jsPolicyLine, META_PREFIX, observationMeta, UNTRUSTED_CONTENT_NOTICE } from './formatObservation.js';
import { checkTargetUrl, effectivePolicy, hiddenPolicyArgs, withDownloadPermission } from './policyArgs.js';
import { fail, ok, type ToolTextResult } from './types.js';

/**
 * Pure formatting of a browse_url result: the quarantine extraction when it is valid, otherwise the
 * deterministic page text with an error note. Raw model text is never shown.
 */
export function formatBrowseResult(
  obs: Observation,
  quarantine: QuarantineExtraction | null,
  events: string[] = [],
): ToolTextResult {
  let injection = obs.injection;
  let body: string;
  let header: string;
  let extractionSource: 'quarantine_model' | 'deterministic';
  let quarantineError: string | undefined;

  if (quarantine?.ok) {
    extractionSource = 'quarantine_model';
    // The model read untrusted text and may echo an injection — score its output too.
    const outScore = scoreInjection({ text: quarantine.extraction });
    if (outScore.score > 0) {
      const score = injection.score + outScore.score;
      injection = {
        suspected: injection.suspected || outScore.suspected || score >= 3,
        score,
        reasons: [...injection.reasons, ...outScore.reasons.map(r => `quarantine output: ${r}`)],
      };
    }
    header =
      `── Extracted by quarantine model ${quarantine.model} (derived from untrusted page content` +
      `${quarantine.truncated ? `; page truncated to ${quarantine.inputChars} chars first` : ''}) ──`;
    body = wrapUntrusted(quarantine.found ? quarantine.extraction || '(empty)' : 'Not found.', obs.nonce);
  } else {
    extractionSource = 'deterministic';
    quarantineError = quarantine && !quarantine.ok ? quarantine.error : undefined;
    header = `── Page text (${obs.pageTextChars} chars${obs.pageTextTruncated ? ', truncated' : ''}; deterministic extract) ──`;
    body = wrapUntrusted(obs.pageText || '(no visible text)', obs.nonce);
  }

  const meta = {
    ...observationMeta({ ...obs, injection }, events),
    extraction_source: extractionSource,
    ...(quarantineError ? { quarantine_error: quarantineError } : {}),
  };
  const text = [
    META_PREFIX + JSON.stringify(meta),
    injectionHeader(injection),
    eventsBlock(events),
    `URL: ${obs.url}`,
    `Title (page-supplied): ${JSON.stringify(obs.title)}`,
    jsPolicyLine(obs.jsPolicy),
    quarantineError ? `(quarantine model unusable: ${quarantineError} — showing the deterministic page text instead; find the requested information in it yourself)` : null,
    '',
    header,
    body,
  ]
    .filter((s): s is string => s !== null && s !== undefined)
    .join('\n');
  return ok(text, meta);
}

export function registerBrowseUrl(server: McpServer, config: PlaywrightConfig): void {
  server.tool(
    'browse_url',
    'Navigate to a URL and extract specific information from the page (one-shot, no session). ' +
      'If the local quarantine model is enabled it extracts what you specify in `extract`; otherwise ' +
      '(or if its output is invalid) you get the cleaned, length-bounded visible page text. ' +
      UNTRUSTED_CONTENT_NOTICE,
    {
      url: z.string().url().describe('The URL to visit. Must be http or https.'),
      extract: z
        .string()
        .describe(
          'What to extract from the page. Be specific. Examples: ' +
            '"main article text", "all hyperlinks with their anchor text", ' +
            '"the product price and availability", "a JSON summary of the key facts".',
        ),
      wait_for_idle: z
        .boolean()
        .optional()
        .describe('Wait for network to be idle before extracting. Default true. Set false for fast pages.'),
      ...hiddenPolicyArgs,
    },
    async ({ url, extract, wait_for_idle = true, _policy, _allow_downloads }) => {
      const policy = effectivePolicy(config, _policy);
      const blocked = await checkTargetUrl(config, policy, url);
      if (blocked) return fail(blocked);

      const state = newSessionState(policy, _policy);
      let hc: HardenedContext | undefined;
      try {
        hc = await launchHardenedContext(state, guardFor(config));
        const { page } = hc;
        page.setDefaultTimeout(config.navTimeoutMs);
        return await withDownloadPermission(state, _allow_downloads, async () => {
          await page.goto(url, {
            waitUntil: wait_for_idle ? 'networkidle' : 'domcontentloaded',
            timeout: config.navTimeoutMs,
          });
          const capture = await capturePage(page, config);
          const obs = buildObservation(capture, {
            maxTextChars: config.observationMaxTextChars,
            labelMax: config.observationLabelMaxChars,
            jsPolicy: policy.js,
          });
          let quarantine: QuarantineExtraction | null = null;
          if (config.quarantineExtractEnabled) {
            // The model gets the full cleaned visible text (bounded by QUARANTINE_MAX_INPUT_CHARS), not raw innerText.
            const full = buildObservation(capture, { maxTextChars: config.quarantineMaxInputChars, labelMax: 1, jsPolicy: policy.js });
            quarantine = await extractWithQuarantine(config, full.pageText, extract);
          }
          return formatBrowseResult(obs, quarantine, drainEvents(state));
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const events = drainEvents(state);
        return fail(`browse_url error: ${message}` + (events.length ? '\n' + events.map(e => `- ${e}`).join('\n') : ''));
      } finally {
        await hc?.browser.close().catch(() => {});
      }
    },
  );
}
