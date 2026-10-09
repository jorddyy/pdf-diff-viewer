// "Wrong pair?" on a figure entry: choose "None" and check the figure is reported as removed + added.
//   npx tsx scripts/dev/e2e-repair.ts URL out-dir old.pdf new.pdf
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const [url, outDir, ...pdfs] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ browser: 'chrome', executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', (e as Error).message));
await page.goto(url, { waitUntil: 'load' });
await (await page.$('input[type=file]'))!.uploadFile(...pdfs.map((p) => path.resolve(p)));
await page.waitForSelector('.changes', { timeout: 300_000 });
await page.waitForFunction(() => !document.querySelector('.note'), { timeout: 600_000 }).catch(() => {});
const figs = () => page.$$eval('.chg.fig .lbl', (els) => els.map((e) => e.textContent));
const before = await figs();
console.log('figure entries before:', before.length, before.slice(0, 4));
const first = (await page.$$('.chg.fig .chg-head'))[0];
await first.click();
await sleep(800);
await page.screenshot({ path: path.join(outDir, 'repair-click.png') });
console.log('classes:', await page.$$eval('.chg.fig', (els) => els.slice(0, 3).map((e) => e.className)));
await page.waitForSelector('.chg.fig.sel .repair');
await page.click('.chg.fig.sel .repair');
await page.waitForSelector('.modal.pair select');
await page.screenshot({ path: path.join(outDir, 'repair-dialog.png') });
await page.select('.modal.pair select', '');
await page.evaluate(() => ([...document.querySelectorAll('.modal.pair .btn.primary')][0] as HTMLElement).click());
await sleep(1500);
await page.waitForFunction(() => !document.querySelector('.note'), { timeout: 600_000 }).catch(() => {});
const after = await figs();
console.log('figure entries after:', after.length, after.slice(0, 4));
console.log(after.length >= before.length && after.join() !== before.join() ? 'PASS' : 'FAIL', 'entries changed');
await page.screenshot({ path: path.join(outDir, 'repair-after.png') });
await browser.close();
