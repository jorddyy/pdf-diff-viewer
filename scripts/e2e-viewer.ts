// Viewer behaviour checks: theme, synchronised scrolling, landscape pages,
// text selection, figure panels, horizontal position after navigation.
//   npx tsx scripts/e2e-viewer.ts URL out-dir old.pdf new.pdf   (BROWSER=firefox for Firefox)
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
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push([name, ok, info]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
};
const shot = (name: string) => page.screenshot({ path: path.join(outDir, `${name}.png`) });

await page.goto(url, { waitUntil: 'load' });
await (await page.$('input[type=file]'))!.uploadFile(...pdfs.map((p) => path.resolve(p)));
await page.waitForSelector('.change-list', { timeout: 180_000 });
await page.waitForFunction(() => !document.querySelector('.note'), { timeout: 120_000 }).catch(() => {});
await sleep(1000);
await shot('v1-overview');

// Theme switch.
const themes: string[] = [];
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => ([...document.querySelectorAll('.view .btn')].find((b) => /Auto|Light|Dark/.test(b.textContent ?? '')) as HTMLElement).click());
  await sleep(200);
  themes.push(await page.evaluate(() => document.documentElement.dataset.theme ?? 'auto'));
  if (themes.length === 1) await shot('v2-light');
}
check('theme cycles light → dark → auto', themes.join(',') === 'light,dark,auto', themes.join(','));

// No horizontal overflow in fit mode.
const overflow = await page.$$eval('.pane', (ps) => ps.map((p) => p.scrollWidth - p.clientWidth));
check('no horizontal overflow when fitting', overflow.every((o) => o <= 1), overflow.join(','));

// Synchronised scrolling: wheel over pane A, then check B follows and A is not pushed back.
const panes = await page.$$('.pane');
const boxA = (await panes[0].boundingBox())!;
await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
const before = await page.$$eval('.pane', (ps) => ps.map((p) => p.scrollTop));
for (let i = 0; i < 12; i++) {
  await page.mouse.wheel({ deltaY: 400 });
  await sleep(40);
}
await sleep(900);
const after = await page.$$eval('.pane', (ps) => ps.map((p) => p.scrollTop));
const samples: number[][] = [];
for (let i = 0; i < 5; i++) {
  await sleep(150);
  samples.push(await page.$$eval('.pane', (ps) => ps.map((p) => p.scrollTop)));
}
check('scrolling A moves B', after[1] - before[1] > 500, `A ${before[0]}→${after[0]}, B ${before[1]}→${after[1]}`);
check('no jitter after scrolling stops', samples.every((s) => s[0] === after[0] && s[1] === after[1]), JSON.stringify(samples.map((s) => s.map(Math.round))));
const follow = await page.evaluate(() => {
  const list = document.querySelector('.change-list')!;
  const lr = list.getBoundingClientRect();
  const inview = [...document.querySelectorAll<HTMLElement>('.chg.inview')];
  const firstShown = inview[0]?.getBoundingClientRect();
  return {
    scroll: Math.round(list.scrollTop),
    pages: inview.map((e) => e.querySelector('.pages')?.textContent?.trim()),
    visibleInList: !!firstShown && firstShown.top >= lr.top - 1 && firstShown.top < lr.bottom,
  };
});
check('the change list follows the PDFs', follow.scroll > 0 && follow.pages.length > 0 && follow.visibleInList, `list at ${follow.scroll}px; on screen: ${follow.pages.slice(0, 3).join(' | ')}`);
await shot('v3-after-scroll');

// Landscape page fits the pane.
const pages = await page.$$eval('.pane', (ps) => ps.map((p) => [...p.querySelectorAll<HTMLElement>('.page')].map((e) => e.offsetWidth)));
const widest = Math.max(...pages[0]);
const paneW = await page.$eval('.pane', (p) => p.clientWidth);
check('landscape page fits the pane', widest <= paneW, `widest ${widest}px, pane ${paneW}px`);

// Text selection on a page: drag across a line of text.
const span = await page.evaluateHandle(() => {
  const spans = [...document.querySelectorAll<HTMLElement>('.pane .textLayer span')].filter((s) => {
    const r = s.getBoundingClientRect();
    return r.width > 150 && r.top > 100 && r.bottom < window.innerHeight - 50;
  });
  return spans[0] ?? null;
});
const sb = await (span as any).boundingBox?.();
if (sb) {
  await page.mouse.move(sb.x + 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width - 2, sb.y + sb.height / 2, { steps: 8 });
  await page.mouse.up();
  const text = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  check('text on a page can be selected', text.trim().length > 10, JSON.stringify(text.slice(0, 60)));
} else check('text on a page can be selected', false, 'no text layer span found');

// Text selection in the change list.
// A card that is visible in the list (the list follows the PDFs, so not necessarily the first).
const card = await page.evaluateHandle(() => {
  const lr = document.querySelector('.change-list')!.getBoundingClientRect();
  return [...document.querySelectorAll<HTMLElement>('.chg:not(.fig) .snip')].find((e) => {
    const r = e.getBoundingClientRect();
    return r.top > lr.top + 5 && r.bottom < lr.bottom - 5 && r.width > 100;
  });
});
const cb = await (card as any).boundingBox();
const selBefore = await page.$eval('.chg.sel', (e) => e.getAttribute('data-key')).catch(() => null);
await page.mouse.move(cb!.x + 3, cb!.y + 5);
await page.mouse.down();
await page.mouse.move(cb!.x + cb!.width - 5, cb!.y + 5, { steps: 8 });
await page.mouse.up();
const listSel = await page.evaluate(() => window.getSelection()?.toString() ?? '');
const selAfter = await page.$eval('.chg.sel', (e) => e.getAttribute('data-key')).catch(() => null);
check('text in the change list can be selected without navigating', listSel.trim().length > 5 && selBefore === selAfter, JSON.stringify(listSel.slice(0, 40)));

// Navigate to a change: no sideways jump in fit mode.
await page.evaluate(() => window.getSelection()?.removeAllRanges());
await page.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.chg:not(.fig)')][8] ?? null)?.click());
await sleep(1200);
const lefts = await page.$$eval('.pane', (ps) => ps.map((p) => p.scrollLeft));
check('no sideways jump after selecting a change', lefts.every((l) => l === 0), lefts.join(','));
await shot('v4-change');

// Clicking a highlight on the page reveals its entry in the list, also a second time.
await page.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.chg:not(.fig)')][40] ?? null)?.click());
await sleep(1500);
for (const attempt of [1, 2]) {
  await page.$eval('.change-list', (l) => (l.scrollTop = 0));
  await sleep(300);
  const mk = await page.evaluateHandle(() => {
    const panes = document.querySelectorAll('.pane');
    return panes[1].querySelector('.mk.sel') ?? panes[0].querySelector('.mk.sel');
  });
  const mb = await (mk as any).boundingBox?.();
  if (!mb) {
    check(`clicking a highlight reveals its entry (${attempt})`, false, 'no selected mark on the page');
    break;
  }
  await page.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await sleep(1200);
  const pos = await page.evaluate(() => {
    const list = document.querySelector('.change-list')!.getBoundingClientRect();
    const sel = document.querySelector('.chg.sel')?.getBoundingClientRect();
    return sel ? { rel: (sel.top + sel.height / 2 - list.top) / list.height } : null;
  });
  check(`clicking a highlight reveals its entry (${attempt})`, !!pos && pos.rel > 0.2 && pos.rel < 0.8, pos ? `entry at ${(100 * pos.rel).toFixed(0)}% of the list` : 'no selected entry');
}

// Figure panels: open a changed figure from the list and check panel states.
const opened = await page.evaluate(() => {
  const entry = [...document.querySelectorAll('.chg.fig')].find((e) => e.textContent?.includes('Figure changed'));
  (entry?.querySelector('.link') as HTMLElement | null)?.click();
  return entry?.querySelector('.snip')?.textContent ?? null;
});
if (opened) {
  await page.waitForSelector('.pair-view img', { timeout: 60_000 });
  await sleep(1500);
  const states = await page.$$eval('.pstate', (es) => es.map((e) => e.textContent));
  check('compare dialog shows panel states', states.length > 0, `${opened} | ${states.join(',')}`);
  await shot('v5-compare');
  await page.keyboard.press('Escape');
}
const labels = await page.$$eval('.mk-label', (es) => es.map((e) => e.textContent));
check('changed figures have panel labels', labels.length > 0, [...new Set(labels)].join(','));

await browser.close();
const failed = results.filter((r) => !r[1]).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
