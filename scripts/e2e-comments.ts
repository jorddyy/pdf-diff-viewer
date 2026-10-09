// Load two versions plus a Markdown review, check the comments panel, take screenshots.
//   npx tsx scripts/e2e-comments.ts URL out-dir review.md old.pdf new.pdf   (BROWSER=firefox for Firefox)
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const [url, outDir, md, ...pdfs] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const firefox = process.env.BROWSER === 'firefox';
if (firefox) {
  fs.mkdirSync(path.resolve('e2e-tmp'), { recursive: true });
  process.env.TMPDIR = path.resolve('e2e-tmp');
}
const browser = await puppeteer.launch({
  browser: firefox ? 'firefox' : 'chrome',
  executablePath: firefox ? '/snap/bin/firefox' : '/snap/bin/chromium',
  headless: true,
  args: firefox ? [] : ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', (e as Error).message));
page.on('console', (m) => m.type() === 'error' && console.log('[console.error]', m.text()));
await page.goto(url, { waitUntil: 'load' });
await (await page.$('input[type=file]'))!.uploadFile(...pdfs.map((p) => path.resolve(p)));
const t0 = Date.now();
await page.waitForSelector('.change-list', { timeout: 300_000 });
console.log(`diff ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await page.evaluate(() => ([...document.querySelectorAll('.tabs button')].find((b) => b.textContent?.trim().startsWith('Comments')) as HTMLElement).click());
await page.waitForSelector('.comments textarea');
await page.$eval('.comments textarea', (el, text) => {
  const ta = el as HTMLTextAreaElement;
  ta.value = text as string;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}, fs.readFileSync(md, 'utf8'));
await page.evaluate(() => (document.querySelector('.comments .btn.primary') as HTMLElement).click());
await page.waitForSelector('.chg.cmt', { timeout: 60_000 });
await sleep(800);
console.log('rounds:', await page.$$eval('.round', (els) => els.map((e) => `${e.querySelector('span')?.textContent} → ${(e.querySelector('select') as HTMLSelectElement).selectedOptions[0]?.textContent}`)));
console.log('filters:', await page.$$eval('.comments .filters .chip', (els) => els.map((e) => e.textContent?.trim())));
await page.screenshot({ path: path.join(outDir, 'c1-list.png') });
const pick = process.env.PICK ?? "to altered";
await page.evaluate((pick) => {
  const el = [...document.querySelectorAll('.chg.cmt')].find((e) => e.textContent?.includes(pick)) as HTMLElement | undefined;
  el?.click();
}, pick);
await sleep(+(process.env.WAIT ?? 1500));
console.log('rendered canvases:', await page.$$eval('.page canvas', (cs) => cs.filter((c) => (c as HTMLCanvasElement).width > 0).length));
await page.screenshot({ path: path.join(outDir, 'c2-selected.png') });
if (process.env.HISTORY) {
  const t0 = Date.now();
  await page.evaluate(() => (document.querySelector('.row.tools input[type=checkbox]') as HTMLElement | null)?.click());
  await page.waitForSelector('.hist', { timeout: 180_000 });
  console.log(`history computed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await sleep(500);
  await page.screenshot({ path: path.join(outDir, 'c3-history.png') });
}
const exported = await page.evaluate(async () => {
  const btn = [...document.querySelectorAll('.row.tools .btn')].find((b) => b.textContent?.startsWith('Copy')) as HTMLElement;
  return btn ? 'ok' : 'missing';
});
console.log('export button', exported);
await browser.close();
