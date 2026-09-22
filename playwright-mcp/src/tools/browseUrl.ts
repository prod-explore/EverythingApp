import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { chromium } from 'playwright';
import type { PlaywrightConfig } from '../config.js';
import { extractWithQuarantine } from '../quarantine.js';

/** Allowlist of URL schemes. Only http(s) allowed. */
function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function registerBrowseUrl(server: McpServer, config: PlaywrightConfig): void {
  server.tool(
    'browse_url',
    'Navigate to a URL and extract specific information from the page. ' +
      'Raw page content NEVER reaches you directly — it passes through a local quarantine model ' +
      'that extracts only what you specify. This protects against prompt injection from web content. ' +
      'Specify exactly what you want to extract in the `extract` parameter.',
    {
      url: z
        .string()
        .url()
        .describe('The URL to visit. Must be http or https.'),
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
    },
    async ({ url, extract, wait_for_idle = true }) => {
      if (!isAllowedUrl(url)) {
        return {
          content: [{ type: 'text', text: 'Error: only http/https URLs are allowed.' }],
          isError: true,
        };
      }

      let browser;
      try {
        browser = await chromium.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Pi has limited /dev/shm
            '--disable-gpu',
          ],
        });

        const context = await browser.newContext({
          // No credentials, no stored cookies, no persistent state.
          storageState: undefined,
          userAgent:
            'Mozilla/5.0 (compatible; EverythingAppBot/1.0; +https://futumore.pl)',
        });

        const page = await context.newPage();
        page.setDefaultTimeout(config.navTimeoutMs);

        await page.goto(url, {
          waitUntil: wait_for_idle ? 'networkidle' : 'domcontentloaded',
          timeout: config.navTimeoutMs,
        });

        // Extract raw text from the page body — this is the ONLY thing that goes
        // into the quarantine model. No HTML, no cookies, no scripts.
        const rawText = await page.evaluate(() => document.body.innerText);
        const pageTitle = await page.title();

        // ── Quarantine extraction ──────────────────────────────────────────
        // Raw page text never reaches the privileged agent loop.
        // The quarantine model extracts only what was requested.
        const result = await extractWithQuarantine(config, rawText, extract);

        const summary = [
          `URL: ${url}`,
          `Page title: ${pageTitle}`,
          `Quarantine model: ${result.model}`,
          result.truncated ? `(Page was truncated to ${result.inputChars} chars before extraction)` : null,
          '',
          '── Extracted content ──',
          result.extraction,
        ]
          .filter(s => s !== null)
          .join('\n');

        return { content: [{ type: 'text', text: summary }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `browse_url error: ${message}` }],
          isError: true,
        };
      } finally {
        await browser?.close();
      }
    },
  );
}
