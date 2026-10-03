// Drive the app in (snap) Chromium: load PDFs, wait for the diff, take screenshots.
//   npx tsx scripts/e2e.ts http://localhost:5199/ out-dir old.pdf new.pdf
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const [url, outDir, ...pdfs] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// BROWSER=firefox uses (snap) Firefox; its profile must live where the snap can see it.
const firefox = process.env.BROWSER === 'firefox';
if (firefox) {
  const tmp = path.resolve('e2e-tmp');
  fs.mkdirSync(tmp, { recursive: true });
  process.env.TMPDIR = tmp;
}
const browser = await puppeteer.launch({
  browser: firefox ? 'firefox' : 'chrome',
  executablePath: firefox ? (process.env.FIREFOX ?? '/snap/bin/firefox') : (process.env.CHROME ?? '/snap/bin/chromium'),
  headless: true,
  args: firefox ? ['--width=1600', '--height=1000'] : ['--no-sandbox', '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'info' || (m.type() === 'warn' && !m.text().includes('standardFontDataUrl'))) console.log(`[console.${m.type()}]`, m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', (e as Error).message));
if (process.env.DARK && !firefox) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await page.goto(url, { waitUntil: 'load' });
const t0 = Date.now();
const input = await page.$('input[type=file]');
await input!.uploadFile(...pdfs.map((p) => path.resolve(p)));
await page.waitForSelector('.change-list', { timeout: 180_000 });
console.log(`diff ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await page.waitForFunction(() => !document.querySelector('.note'), { timeout: 120_000 }).catch(() => console.log('figures still pending'));
console.log(`figures compared after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await sleep(800);
await page.screenshot({ path: path.join(outDir, '1-overview.png') });
const figs = await page.$$('.chg.fig');
console.log(`${(await page.$$('.chg')).length} entries, ${figs.length} figure entries`);
console.log((await page.$$eval('.chg.fig .chg-head', (els) => els.map((e) => e.textContent))).join('\n'));
const opened = await page.evaluate((title) => {
  const entry = [...document.querySelectorAll('.chg.fig')].find((e) => e.textContent?.includes(title ?? 'Figure changed'));
  (entry?.querySelector('.link') as HTMLElement | null)?.click();
  return !!entry;
}, process.env.FIGURE ?? null);
if (opened) {
  await page.waitForSelector('.pair-view img', { timeout: 60_000 });
  await sleep(500);
  await page.screenshot({ path: path.join(outDir, '2-compare-side.png') });
  const diffTab = (await page.$$('.modes .chip'))[2];
  await diffTab.click();
  await sleep(500);
  await page.screenshot({ path: path.join(outDir, '3-compare-diff.png') });
  await page.keyboard.press('Escape');
}
const items = await page.$$('.chg:not(.fig)');
if (items[10]) {
  await items[10].click();
  await sleep(1500);
  await page.screenshot({ path: path.join(outDir, '4-change.png') });
}
await browser.close();
