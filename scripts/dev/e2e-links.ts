// Clicks the first internal link found on the left pane and checks the pane scrolled.
//   npx tsx scripts/dev/e2e-links.ts URL out-dir old.pdf new.pdf
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const [url, outDir, ...pdfs] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ browser: 'chrome', executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1600, height: 1000 } });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'load' });
await (await page.$('input[type=file]'))!.uploadFile(...pdfs.map((p) => path.resolve(p)));
await page.waitForSelector('.change-list', { timeout: 180_000 });
await sleep(2000);
// The link layer is internal state; probe by hovering text on the first page for the pointer cursor title.
const pane = (await page.$$('.pane'))[0];
await pane.evaluate((e) => { e.scrollTop = 1800; });
await sleep(2500);
const box = (await pane.boundingBox())!;
let hit: { x: number; y: number } | null = null;
for (let y = box.y + 20; y < box.y + box.height && !hit; y += 5) {
  for (let x = box.x + 40; x < box.x + box.width - 20; x += 6) {
    await page.mouse.move(x, y);
    const over = await page.evaluate(() => !!document.querySelector('.page.over-mark[title*="link target"]'));
    if (over) { hit = { x, y }; break; }
  }
}
console.log('link found at', hit);
if (hit) {
  const before = await pane.evaluate((e) => e.scrollTop);
  await page.mouse.click(hit.x, hit.y);
  await sleep(1000);
  const after = await pane.evaluate((e) => e.scrollTop);
  console.log(after !== before ? 'PASS' : 'FAIL', 'scrollTop', before, '->', after);
  await page.screenshot({ path: path.join(outDir, 'links-after.png') });
  await page.keyboard.down('Alt');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Alt');
  await sleep(600);
  const back = await pane.evaluate((e) => e.scrollTop);
  console.log(back === before ? 'PASS' : 'FAIL', 'Alt+Left returns', after, '->', back, 'back button gone:', !(await page.$('.back-btn')));
}
await page.screenshot({ path: path.join(outDir, 'links.png') });
await browser.close();
