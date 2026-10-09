// Public CI smoke test: generate invented PDFs, then exercise the production build in Firefox.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from '@pdfme/pdf-lib';
import puppeteer from 'puppeteer-core';
import { preview } from 'vite';

const root = path.resolve('e2e-tmp');
await fs.mkdir(root, { recursive: true });
// Snap Firefox cannot access /tmp.
process.env.TMPDIR = root;
const dir = await fs.mkdtemp(path.join(root, 'smoke-'));
const files: string[] = [];
for (const version of [1, 2]) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const artwork = await PDFDocument.create();
  const shape = artwork.addPage([150, 100]);
  shape.drawRectangle({ x: 10, y: 10, width: version === 1 ? 45 : 100, height: 70, color: rgb(0.2, 0.3, 0.4) });
  const [figure] = await pdf.embedPdf(await artwork.save());
  for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
    const page = pdf.addPage([595, 842]);
    for (let row = 0; row < (pageIndex === 2 ? 9 : 18); row++) {
      const line = pageIndex * 18 + row + 1;
      const text = line === 5 ? `The sample colour is ${version === 1 ? 'amber' : 'cobalt'}.`
        : line === 9 ? `The box contains ${version === 1 ? '12' : '18'} wooden blocks.`
        : `This is invented paragraph ${line} describing a quiet garden and its plants.`;
      page.drawText(String(line), { x: 30, y: 780 - row * 30, size: 9, font });
      page.drawText(text, { x: 65, y: 780 - row * 30, size: 11, font });
    }
    if (pageIndex === 2) {
      page.drawPage(figure, { x: 100, y: 300, width: 200, height: 130 });
      page.drawText('Figure 1: An invented geometric pattern.', { x: 65, y: 275, size: 9, font });
    }
  }
  const file = path.join(dir, `synthetic.v${version}.pdf`);
  await fs.writeFile(file, await pdf.save());
  files.push(file);
}

const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
try {
  const address = server.httpServer.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await puppeteer.launch({
    browser: 'firefox', executablePath: process.env.BROWSER_PATH || '/snap/bin/firefox',
    headless: true, defaultViewport: { width: 1600, height: 1000 },
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  const errors: string[] = [];
  const unexpectedRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('request', (request) => {
    const url = request.url();
    if (/^https?:/.test(url) && (new URL(url).origin !== origin || request.method() !== 'GET')) {
      unexpectedRequests.push(`${request.method()} ${url}`);
    }
  });
  await page.evaluateOnNewDocument(() => {
    const readPixels = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args: Parameters<typeof readPixels>) {
      if ((window as any).failFigureRead) throw new Error('Synthetic figure rendering failure');
      return readPixels.apply(this, args);
    };
    const NativeWorker = window.Worker;
    (window as any).liveWorkers = 0;
    window.Worker = class extends NativeWorker {
      private stopped = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        if ((window as any).workerFailures > 0) {
          (window as any).workerFailures--;
          throw new Error('Synthetic transient worker failure');
        }
        super(url, options);
        (window as any).liveWorkers++;
      }
      terminate() {
        if (!this.stopped) (window as any).liveWorkers--;
        this.stopped = true;
        super.terminate();
      }
    };
  });
  const clickText = async (selector: string, text: string) => {
    assert(await page.evaluate((selector, text) => {
      const el = [...document.querySelectorAll<HTMLElement>(selector)].find((e) => e.textContent?.includes(text));
      el?.click();
      return !!el;
    }, selector, text), `Missing button: ${text}`);
  };
  // Wait for the actual IndexedDB transaction, rather than a fixed autosave delay.
  const saved = async (comments: string, doneCount: number) => {
    await page.waitForFunction(async (comments, doneCount) => {
      const workspaces = await new Promise<any[]>((resolve, reject) => {
        const req = indexedDB.open('pdf-diff-workspaces', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('workspaces');
          const rows = tx.objectStore('workspaces').getAll();
          tx.oncomplete = () => { db.close(); resolve(rows.result); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
      });
      return workspaces.some((ws) => ws.versions.length === 2 && ws.comments === comments && ws.done.length === doneCount);
    }, {}, comments, doneCount);
  };

  await page.goto(origin, { waitUntil: 'load' });
  await page.waitForSelector('.welcome');
  await page.evaluate(() => {
    // Vite retries an inline worker with a data URL after a blob URL fails.
    (window as any).workerFailures = 2;
    (window as any).failFigureRead = true;
  });
  await (await page.$('input[type=file]'))!.uploadFile(files[0]);
  await page.waitForSelector('.vchip.err');
  await (await page.$('input[type=file]'))!.uploadFile(...files);
  await page.waitForFunction(() => {
    const text = document.querySelector('.change-list')?.textContent ?? '';
    return text.includes('amber') && text.includes('cobalt') && text.includes('Number');
  }, { timeout: 90_000 });
  await page.waitForFunction(() => document.querySelectorAll('.page .textLayer span').length > 0);
  assert.equal(await page.$$eval('.vchip.err', (es) => es.length), 0);
  assert.equal(await page.$$eval('.vchip', (es) => es.length), 2);
  console.log('PASS a failed PDF can be retried without duplicate versions');
  console.log('PASS synthetic PDFs render and text/number changes are detected');
  await page.waitForFunction(() => document.querySelector('.note')?.textContent?.includes('could not be compared'));
  assert.equal(await page.$$eval('.chg.fig', (es) => es.length), 1);
  assert.match(await page.$eval('.chg.fig', (el) => el.textContent ?? ''), /change status unknown/);
  assert.doesNotMatch(await page.$eval('.chg.fig .badge', (el) => el.textContent ?? ''), /changed/i);
  console.log('PASS a figure rendering failure stays unknown with a visible note');

  await clickText('.tabs button', 'Comments');
  const review = '## Round 1\n\nL5: "amber" -> "cobalt"\nL9: Please check the block count.\n';
  await page.$eval('.comments textarea', (el, text) => {
    (el as HTMLTextAreaElement).value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, review);
  await clickText('.comments .btn.primary', 'Use these comments');
  await page.waitForFunction(() => document.querySelectorAll('.chg.cmt').length === 2);
  await page.click('.chg.cmt .done-box');
  await saved(review, 1);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('.chg.cmt').length === 2 && document.querySelectorAll('.chg.cmt.done').length === 1);
  assert.equal(await page.$$eval('.vchip', (es) => es.length), 2);
  console.log('PASS reload restores PDFs, review comments and done ticks');

  await page.click('.chg.cmt .x.del');
  await page.waitForSelector('.toast');
  await page.click('.top h1 .home');
  await page.waitForSelector('.recent li');
  assert.equal(await page.$('.toast'), null, 'Undo must not carry comments into another comparison');
  await page.waitForFunction(() => (window as any).liveWorkers === 0);
  console.log('PASS leaving a comparison clears undo and terminates PDF workers');

  page.on('dialog', (dialog) => void dialog.accept());
  await clickText('button', 'Clear stored data');
  await page.waitForFunction(() => document.querySelectorAll('.recent li').length === 0);
  const counts = await page.evaluate(async () => Promise.all([
    ['pdf-diff-workspaces', 'workspaces'], ['pdf-diff-workspaces', 'files'], ['pdf-diff-cache', 'docs'],
  ].map(([name, store]) => new Promise<number>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(store);
        const rows = tx.objectStore(store).count();
        tx.oncomplete = () => { db.close(); resolve(rows.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    }))));
  assert.deepEqual(counts, [0, 0, 0]);
  assert.deepEqual(errors, [], 'Browser errors');
  assert.deepEqual(unexpectedRequests, [], 'Unexpected network requests');
  console.log('PASS clear stored data removes comparisons, PDFs and extracted text');
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
}
