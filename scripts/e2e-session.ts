// Comments management and saved comparisons across a reload.
//   npx tsx scripts/e2e-session.ts URL out-dir review.md old.pdf new.pdf   (BROWSER=firefox for Firefox)
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
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Renamed comparison' : undefined));
const results: boolean[] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
};
const shot = (name: string) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const clickText = (sel: string, text: string) =>
  page.evaluate(
    (sel, text) => {
      const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text));
      el?.click();
      return !!el;
    },
    sel,
    text,
  );
const cards = () => page.$$eval('.chg.cmt', (es) => es.length);

await page.goto(url, { waitUntil: 'load' });
await (await page.$('input[type=file]'))!.uploadFile(...pdfs.map((p) => path.resolve(p)));
await page.waitForSelector('.change-list', { timeout: 180_000 });
await clickText('.tabs button', 'Comments');
await page.waitForSelector('.comments textarea');
await page.$eval(
  '.comments textarea',
  (el, text) => {
    (el as HTMLTextAreaElement).value = text as string;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
  fs.readFileSync(md, 'utf8'),
);
await clickText('.comments .btn.primary', 'Use these comments');
await page.waitForSelector('.chg.cmt', { timeout: 60_000 });
await sleep(500);
const n0 = await cards();

// Done tick.
await page.$eval('.chg.cmt .done-box', (e) => (e as HTMLElement).click());
await sleep(300);
check('a comment can be ticked off', (await page.$$('.chg.cmt.done')).length === 1);

// Delete one, undo.
const firstText = await page.$$eval('.chg.cmt .snip.new', (es) => es[1]?.textContent ?? '');
await page.$$eval('.chg.cmt .x.del', (es) => (es[1] as HTMLElement).click());
await sleep(500);
const n1 = await cards();
const toast = await page.$eval('.toast', (e) => e.textContent ?? '').catch(() => '');
check('deleting removes one comment', n1 === n0 - 1 && !(await page.content()).includes(firstText.slice(0, 40)), `${n0} → ${n1}`);
check('an undo toast appears', toast.includes('Undo'), toast);
await clickText('.toast .link', 'Undo');
await sleep(500);
check('undo brings it back', (await cards()) === n0);

// Remove all, undo.
await clickText('.row.tools .btn', 'Remove all');
await sleep(500);
check('remove all clears the comments', (await cards()) === 0 && !!(await page.$('.comments textarea')));
await clickText('.toast .link', 'Undo');
await page.waitForSelector('.chg.cmt', { timeout: 10_000 }).catch(() => {});
check('undo restores all comments', (await cards()) === n0);

// Scroll, then reload.
const panes = await page.$$('.pane');
const box = (await panes[1].boundingBox())!;
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < 10; i++) {
  await page.mouse.wheel({ deltaY: 500 });
  await sleep(40);
}
await sleep(2000);
const scrollBefore = await page.$$eval('.pane', (ps) => ps.map((p) => Math.round(p.scrollTop)));
const chips = await page.$$eval('.vchip', (es) => es.map((e) => e.textContent?.replace('×', '').trim()));
await shot('s1-before-reload');
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('.vchip', { timeout: 60_000 });
await page.waitForFunction(() => document.querySelectorAll('.page canvas').length > 0, { timeout: 120_000 });
await sleep(3000);
const chipsAfter = await page.$$eval('.vchip', (es) => es.map((e) => e.textContent?.replace('×', '').trim()));
check('reload restores the versions', JSON.stringify(chips) === JSON.stringify(chipsAfter), chipsAfter.join(','));
const scrollAfter = await page.$$eval('.pane', (ps) => ps.map((p) => Math.round(p.scrollTop)));
check('reload restores the scroll position', Math.abs(scrollAfter[1] - scrollBefore[1]) < 60, `${scrollBefore} → ${scrollAfter}`);
await clickText('.tabs button', 'Comments');
await page.waitForSelector('.chg.cmt', { timeout: 30_000 }).catch(() => {});
check('reload restores the comments', (await cards()) === n0, `${await cards()}`);
check('reload restores done ticks', (await page.$$('.chg.cmt.done')).length === 1);
const title = await page.$eval('.ws-title', (e) => e.textContent ?? '').catch(() => '');
check('the comparison has a title', title.length > 3, title);
await shot('s2-after-reload');

// Start page with the recent list.
await page.click('.top h1 .home');
await page.waitForSelector('.recent li', { timeout: 10_000 }).catch(() => {});
const recent = await page.$$eval('.recent li', (es) => es.map((e) => e.textContent ?? ''));
check('the start page lists the comparison', recent.length === 1, recent[0]?.slice(0, 80));
await shot('s3-start-page');
await page.click('.recent .title');
await page.waitForSelector('.vchip', { timeout: 30_000 });
check('opening it from the list restores it', (await page.$$('.vchip')).length === chips.length);
await page.click('.top h1 .home');
await page.waitForSelector('.recent li', { timeout: 10_000 });
await page.$eval('.recent .acts .btn[title="Rename"]', (e) => (e as HTMLElement).click());
await sleep(800);
const renamed = await page.$eval('.recent .title', (e) => e.textContent ?? '');
check('a comparison can be renamed', renamed === 'Renamed comparison', renamed);
await page.$eval('.recent .acts .btn[title^="Delete"]', (e) => (e as HTMLElement).click());
await sleep(800);
check('a comparison can be deleted', (await page.$$('.recent li')).length === 0);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
