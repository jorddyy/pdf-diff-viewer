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

function newWorker() {
  return new pdfjs.PDFWorker({ port: new PdfjsWorker() } as any);
}

export interface PageSize {
  width: number;
  height: number;
}

/** Open a PDF for display (one pdf.js worker per document) and read its page sizes. */
export async function openForDisplay(bytes: ArrayBuffer): Promise<{ pdf: PDFDocumentProxy; sizes: PageSize[] }> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), worker: newWorker(), verbosity: 0, standardFontDataUrl }).promise;
  const sizes: PageSize[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const vp = (await pdf.getPage(p)).getViewport({ scale: 1 });
    sizes.push({ width: vp.width, height: vp.height });
  }
  return { pdf, sizes };
}

/** A separate handle (own worker) for background rendering, e.g. figure comparison. */
export function openForCompare(bytes: ArrayBuffer): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), worker: newWorker(), verbosity: 0, standardFontDataUrl }).promise;
}

/**
 * Extract the document model, spreading pages over several pdf.js workers.
 * The file never leaves the browser: workers are inline blobs.
 */
export async function extractInBrowser(bytes: ArrayBuffer, name: string, onProgress?: Progress): Promise<DocModel> {
  // Documents are analysed concurrently, so each gets a share of the cores.
  const n = Number(new URLSearchParams(location.search).get('workers')) || Math.max(2, Math.min(4, Math.floor(((navigator.hardwareConcurrency || 4) - 1) / 2)));
  const workers = Array.from({ length: n }, newWorker);
  const handles = await Promise.all(
    workers.map((worker) => pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), worker, verbosity: 0, standardFontDataUrl }).promise),
  );
  try {
    const t0 = performance.now();
    const doc = await extractDocument(handles, pdfjs.OPS as any, name, { bytes: new Uint8Array(bytes), inflate: browserInflate, onProgress });
    console.info(`[pdf-diff] analysed ${name} (${doc.numPages} pages) in ${((performance.now() - t0) / 1000).toFixed(1)} s with ${n} workers`);
    return doc;
  } finally {
    await Promise.all(handles.map((h) => h.loadingTask.destroy()));
    workers.forEach((w) => w.destroy());
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
