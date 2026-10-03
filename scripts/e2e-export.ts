// Export both PDF formats and save them for inspection.
//   npx tsx scripts/e2e-export.ts URL out-dir old.pdf new.pdf   (BROWSER=firefox for Firefox)
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const [url, outDir, ...pdfs] = process.argv.slice(2);
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
// Keep the last generated download in the page so the test can read it.
await page.evaluate(() => {
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b: Blob | MediaSource) => {
    (window as any).__lastBlob = b;
    return orig(b);
  };
  HTMLAnchorElement.prototype.click = function () {
    (window as any).__lastName = this.download;
  };
});
await (await page.$('input[type=file]'))!.uploadFile(...pdfs.map((p) => path.resolve(p)));
await page.waitForSelector('.change-list', { timeout: 180_000 });
await page.waitForFunction(() => !document.querySelector('.note'), { timeout: 180_000 }).catch(() => {});

for (const format of ['side', 'annotated'] as const) {
  await page.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.view .btn')].find((b) => b.textContent?.includes('Export')) as HTMLElement).click());
  await page.waitForSelector('.modal.export');
  await page.evaluate((format) => {
    const radios = document.querySelectorAll<HTMLInputElement>('.modal.export input[type=radio]');
    radios[format === 'side' ? 0 : 1].click();
    (window as any).__lastBlob = null;
  }, format);
  const t0 = Date.now();
  await page.evaluate(() => (document.querySelector('.modal.export .btn.primary') as HTMLElement).click());
  await page.waitForFunction(() => (window as any).__lastBlob, { timeout: 300_000 });
  const b64 = await page.evaluate(async () => {
    const buf = new Uint8Array(await ((window as any).__lastBlob as Blob).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const name = await page.evaluate(() => (window as any).__lastName as string);
  const file = path.join(outDir, `export-${format}.pdf`);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log(`${format}: "${name}" ${(fs.statSync(file).size / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${file}`);
  await sleep(500);
}
await browser.close();
