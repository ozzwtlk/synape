// Screenshot the running Synape UI. Usage: node scripts/shot.mjs <out.png> [hash] [--click <taskTitle>] [--wait ms] [--w 1680 --h 980]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const out = args[0] ?? 'shot.png';
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const url = `http://127.0.0.1:${opt('--port', '7420')}/${opt('--hash', '') ? '#' + opt('--hash', '') : ''}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +opt('--w', 1680), height: +opt('--h', 980) }, deviceScaleFactor: +opt('--dpr', 1) });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(url);
await page.waitForTimeout(+opt('--wait', 2500));
const click = opt('--click', '');
if (click) { await page.getByText(click, { exact: false }).first().click(); await page.waitForTimeout(900); }
const tab = opt('--tab', '');
if (tab) { await page.getByRole('tab', { name: tab }).click(); await page.waitForTimeout(900); }
if (args.includes('--hud')) { await page.locator('.hud').click(); await page.waitForTimeout(500); }
if (args.includes('--flow')) { await page.getByRole('tab', { name: 'Flow' }).click(); await page.waitForTimeout(1200); }
if (args.includes('--new')) { await page.getByText('+ New mission').click(); await page.waitForTimeout(600); }
const scrub = opt('--scrub', '');
if (scrub) { const b = await page.locator('.tl-track').boundingBox(); await page.mouse.click(b.x + b.width * +scrub, b.y + b.height / 2); await page.waitForTimeout(1200); }
await page.screenshot({ path: out });
console.log(out, errors.length ? `\nERRORS:\n${errors.join('\n')}` : '(no console errors)');
await browser.close();
