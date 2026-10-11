// Regenerates docs/img/*.png against a running mock stack:  OUT=docs/img BASE=http://localhost:3000 PASSWORD=dev CHROME=/path/to/chrome node tools/screenshots.mjs
// Needs: npm i playwright-core (not a dependency of the repo).
import { chromium } from 'playwright-core';
const OUT = process.env.OUT;
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const BASE = process.env.BASE ?? 'http://localhost:3000';
async function open(vp, mobile) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile, isMobile: mobile });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.fill('input[placeholder="Password"]', process.env.PASSWORD ?? 'pw'); await page.keyboard.press('Enter');
  await page.waitForSelector('#composer-input');
  return page;
}
const send = async (page, t) => { await page.fill('#composer-input', t); await page.keyboard.press('Enter'); };
const idle = page => page.waitForSelector('button[aria-label="Send message"]', { timeout: 30000 });

let page = await open({ width: 1440, height: 900 });
await send(page, 'long'); await page.waitForSelector('text=A longer answer'); await idle(page);
await page.screenshot({ path: `${OUT}/chat.png` });
await send(page, 'ask: pick a database'); await page.waitForSelector('[aria-label="Questions from the agent"]');
await page.screenshot({ path: `${OUT}/question.png` });
await page.locator('[aria-label="Questions from the agent"] >> text=Dismiss').first().click(); await idle(page);
await send(page, 'spawn'); await idle(page);
await page.click('button[aria-label="Agents"]'); await page.waitForSelector('text=Completed');
await page.screenshot({ path: `${OUT}/agents.png` });
await page.reload(); await page.waitForSelector('#composer-input');
await page.locator('#composer-input').blur();
for (const k of ['Control+k', 'Meta+k']) { await page.keyboard.press(k); if (await page.locator('[aria-label="Search conversations"]').count()) break; }
await page.waitForSelector('[aria-label="Search conversations"]');
await page.fill('[aria-label="Search conversations"] input', 'markdown'); await page.waitForSelector('text=In messages');
await page.screenshot({ path: `${OUT}/search.png` });
await page.keyboard.press('Escape');
await page.fill('#composer-input', '/');
await page.waitForSelector('[aria-label="Commands"]');
await page.screenshot({ path: `${OUT}/slash.png` });
await page.context().close();

page = await open({ width: 390, height: 844 }, true);
await send(page, 'long'); await page.waitForSelector('text=A longer answer'); await idle(page);
await page.screenshot({ path: `${OUT}/mobile.png` });
await browser.close();
