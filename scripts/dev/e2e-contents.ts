// Opens the Contents tab, clicks a section and checks both panes scrolled.
//   npx tsx scripts/dev/e2e-contents.ts URL out-dir old.pdf new.pdf
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const [url, outDir, ...pdfs] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ browser: 'chrome', executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1600, height: 1000 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', (e as Error).message));
await page.goto(url, { waitUntil: 'load' });
await (await page.$('input[type=file]'))!.uploadFile(...pdfs.map((p) => path.resolve(p)));
await page.waitForSelector('.change-list, .changes', { timeout: 180_000 });
await sleep(2000);
await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[role=tab]')].find((b) => b.textContent?.trim() === 'Contents')!.click());
await page.waitForSelector('.toc-row');
const rows = await page.$$('.toc-row');
console.log('rows', rows.length);
const panes = await page.$$('.pane');
const before = await Promise.all(panes.map((p) => p.evaluate((e) => e.scrollTop)));
await rows[Math.min(8, rows.length - 1)].click();
await sleep(1500);
const after = await Promise.all(panes.map((p) => p.evaluate((e) => e.scrollTop)));
console.log(JSON.stringify(before), '->', JSON.stringify(after), after[0] !== before[0] && after[1] !== before[1] ? 'PASS' : 'FAIL');
console.log('inview:', await page.evaluate(() => document.querySelector('.toc-row.inview')?.textContent));
await page.screenshot({ path: path.join(outDir, 'contents.png') });
await browser.close();
