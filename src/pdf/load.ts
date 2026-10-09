import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';
import { extractDocument, type Progress } from '../extract/document';
import type { DocModel } from '../extract/types';
import type { Inflate } from './scan';

export { pdfjs };

// Fonts that PDFs reference without embedding (often Helvetica in ROOT plots).
// Served next to index.html.
// Opened from disk the fetches would be blocked, so pdf.js uses system fonts directly.
const standardFontDataUrl = location.protocol === 'file:' ? undefined : new URL('standard_fonts/', document.baseURI).href;

function startDocument(bytes: ArrayBuffer) {
  const port = new PdfjsWorker();
  const worker = new pdfjs.PDFWorker({ port } as any);
  try {
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), worker, verbosity: 0, standardFontDataUrl });
    const destroy = task.destroy.bind(task);
    let cleanup: Promise<void> | undefined;
    // pdf.js does not own an explicitly supplied worker or its browser port.
    task.destroy = () => cleanup ??= (async () => {
      try {
        await destroy();
      } finally {
        worker.destroy();
        port.terminate();
      }
    })();
    return task;
  } catch (error) {
    worker.destroy();
    port.terminate();
    throw error;
  }
}

async function openDocument(bytes: ArrayBuffer): Promise<PDFDocumentProxy> {
  const task = startDocument(bytes);
  try {
    return await task.promise;
  } catch (error) {
    await task.destroy().catch(() => {});
    throw error;
  }
}

export interface PageSize {
  width: number;
  height: number;
}

/** Open a PDF for display (one pdf.js worker per document) and read its page sizes. */
export async function openForDisplay(bytes: ArrayBuffer): Promise<{ pdf: PDFDocumentProxy; sizes: PageSize[] }> {
  const pdf = await openDocument(bytes);
  try {
    const sizes: PageSize[] = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const vp = (await pdf.getPage(p)).getViewport({ scale: 1 });
      sizes.push({ width: vp.width, height: vp.height });
    }
    return { pdf, sizes };
  } catch (error) {
    await pdf.loadingTask.destroy().catch(() => {});
    throw error;
  }
}

/** A separate handle (own worker) for background rendering, e.g. figure comparison. */
export function openForCompare(bytes: ArrayBuffer): Promise<PDFDocumentProxy> {
  return openDocument(bytes);
}

/**
 * Extract the document model, spreading pages over several pdf.js workers.
 * The file never leaves the browser: workers are inline blobs.
 */
export async function extractInBrowser(bytes: ArrayBuffer, name: string, onProgress?: Progress): Promise<DocModel> {
  // Documents are analysed concurrently, so each gets a share of the cores.
  const requested = Number(new URLSearchParams(location.search).get('workers'));
  const n = Number.isFinite(requested) && requested > 0
    ? Math.max(1, Math.min(4, Math.floor(requested)))
    : Math.max(2, Math.min(4, Math.floor(((navigator.hardwareConcurrency || 4) - 1) / 2)));
  const tasks: ReturnType<typeof startDocument>[] = [];
  try {
    for (let i = 0; i < n; i++) tasks.push(startDocument(bytes));
    const handles = await Promise.all(tasks.map((task) => task.promise));
    const t0 = performance.now();
    const doc = await extractDocument(handles, pdfjs.OPS as any, name, { bytes: new Uint8Array(bytes), inflate: browserInflate, onProgress });
    console.info(`[pdf-diff] analysed ${name} (${doc.numPages} pages) in ${((performance.now() - t0) / 1000).toFixed(1)} s with ${n} workers`);
    return doc;
  } finally {
    await Promise.allSettled(tasks.map((task) => task.destroy()));
  }
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** zlib inflate via the browser's DecompressionStream, keeping partial output of damaged streams. */
export const browserInflate: Inflate = async (data) => {
  try {
    return await pump(new DecompressionStream('deflate'), data);
  } catch {
    return await pump(new DecompressionStream('deflate-raw'), data.subarray(2));
  }
};

async function pump(ds: DecompressionStream, data: Uint8Array): Promise<Uint8Array> {
  const writer = ds.writable.getWriter();
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch (e) {
    if (!total) throw e;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
