import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DocModel, Line, PageInfo, Piece, Rect, TextQuality, Word } from './types';
import { area, contains, mode, transformRect, type Matrix } from './geometry';
import { PdfFile, scanPage, type Inflate } from '../pdf/scan';
import { itemsToPieces } from './words';
import { detectLineNumbers } from './linenumbers';
import { buildLines } from './lines';
import { extractGraphics, type OpsTable } from './graphics';
import { markHeadersFooters, markObjects, markSections, markToc, type OutlineEntry } from './structure';
import { normalizeToken } from './normalize';

export type Progress = (done: number, total: number) => void;

export interface ExtractOptions {
  /** Raw file bytes and an inflate function enable the fast content-stream scanner. */
  bytes?: Uint8Array;
  inflate?: Inflate;
  onProgress?: Progress;
}

/**
 * Turn a pdf.js document into the DocModel: words grouped in lines (with
 * printed line numbers when present), figures/tables/equations and sections.
 * `OPS` is passed in so the same code runs with the browser and Node builds.
 */
export async function extractDocument(
  pdfs: PDFDocumentProxy | PDFDocumentProxy[],
  OPS: OpsTable,
  name: string,
  opts: ExtractOptions = {},
): Promise<DocModel> {
  // Several handles on the same file (one per pdf.js worker) process pages in parallel.
  const handles = Array.isArray(pdfs) ? pdfs : [pdfs];
  const pdf = handles[0];
  const quality: TextQuality = { glyphs: 0, suspicious: 0, ok: true };
  const pages: PageInfo[] = new Array(pdf.numPages);
  const pagePieces: Piece[][] = new Array(pdf.numPages);

  // Placements of figures and table rules, from the content streams directly.
  let scanned: { file: PdfFile; pages: Awaited<ReturnType<PdfFile['pages']>> } | null = null;
  if (opts.bytes && opts.inflate) {
    try {
      const file = await PdfFile.open(opts.bytes, opts.inflate);
      const list = await file.pages();
      if (list.length === pdf.numPages) scanned = { file, pages: list };
    } catch {
      scanned = null;
    }
  }

  let next = 0;
  let done = 0;
  await Promise.all(
    handles.map(async (h) => {
      while (next < pdf.numPages) {
        const p = next++;
        const page = await h.getPage(p + 1);
        const viewport = page.getViewport({ scale: 1 });
        const vt = viewport.transform as Matrix;
        const tc = await page.getTextContent();
        pagePieces[p] = itemsToPieces(tc.items, tc.styles as any, vt, quality);
        let graphics: Rect[] = [];
        let graphicHashes: string[] = [];
        let rules: Rect[] = [];
        let ok = false;
        if (scanned) {
          try {
            const sp = await scanPage(scanned.file, scanned.pages[p]);
            for (const g of sp.graphics) {
              const r = transformRect(vt, g.rect);
              if (!keepGraphic(r, viewport.width, viewport.height)) continue;
              graphics.push(r);
              graphicHashes.push(g.hash);
            }
            rules = sp.rules.map((r) => transformRect(vt, r));
            ok = true;
          } catch {
            ok = false;
          }
        }
        // pdf.js fallback: parsing all drawing operators is expensive (vector
        // plots), so only do it on pages that have a float caption.
        if (!ok && hasCaption(tc.items as { str?: string }[])) {
          const ol = await page.getOperatorList({ annotationMode: 0 });
          ({ graphics, rules } = extractGraphics(ol as any, OPS, vt));
          graphics = graphics.filter((r) => keepGraphic(r, viewport.width, viewport.height));
          graphicHashes = graphics.map(() => '');
        }
        pages[p] = { width: viewport.width, height: viewport.height, graphics, graphicHashes, rules };
        page.cleanup();
        opts.onProgress?.(++done, pdf.numPages);
      }
    }),
  );
  quality.ok = quality.glyphs === 0 ? false : quality.suspicious / quality.glyphs < 0.002;

  const all = pagePieces.flat();
  const sized = all.filter((p) => p.text.length > 2);
  const bodySize = mode(sized.map((p) => p.size), 0.1);
  const mainText = all.filter((p) => Math.abs(p.size - bodySize) < 0.5);
  const bodyLeft = mode(mainText.map((p) => p.x0), 1);
  const bodyRight = mode(mainText.filter((p) => p.x1 > bodyLeft + 200).map((p) => p.x1), 1);

  const ln = detectLineNumbers(pagePieces, bodyLeft, bodyRight);

  const doc: DocModel = {
    name,
    label: name,
    numPages: pdf.numPages,
    pages,
    words: [],
    lines: [],
    objects: [],
    sections: [],
    hasLineNumbers: ln.found,
    bodyLeft,
    bodyRight,
    bodySize,
    quality,
  };

  pagePieces.forEach((pieces, page) => {
    const graphics = pages[page].graphics;
    // Text inside figures (axis labels, legends) is compared visually, not as text.
    const text = pieces.filter((p) => {
      if (ln.pieces.has(p)) return false;
      const cx = (p.x0 + p.x1) / 2;
      const cy = (p.top + p.bottom) / 2;
      return !graphics.some((g) => contains(g, cx, cy, 1));
    });
    for (const raw of buildLines(page, text, ln.marks[page], bodySize)) {
      const line: Line = {
        id: doc.lines.length,
        page,
        num: raw.num,
        box: raw.box,
        base: raw.base,
        size: raw.size,
        kind: 'body',
        words: [],
        text: raw.text,
        section: -1,
        object: -1,
      };
      for (const w of raw.words) {
        const word: Word = { id: doc.words.length, text: w.text, norm: normalizeToken(w.text), page, box: w.box, line: line.id };
        doc.words.push(word);
        line.words.push(word.id);
      }
      doc.lines.push(line);
    }
  });

  markHeadersFooters(doc);
  markToc(doc);
  markObjects(doc);
  markSections(doc, await readOutline(pdf));
  doc.label = detectLabel(doc, name);
  return doc;
}

/** Ignore specks and page-sized wrappers (e.g. browser re-prints). */
function keepGraphic(r: Rect, width: number, height: number): boolean {
  const a = area(r);
  return a >= 400 && a <= 0.8 * width * height;
}

/** A text item starting a float caption ("Figure 3:", "Table 12."), not a reference in running text. */
function hasCaption(items: { str?: string }[]): boolean {
  for (let i = 0; i < items.length; i++) {
    const s = items[i].str ?? '';
    if (!/^(Figure|Fig\.|Table)\b/.test(s)) continue;
    const rest = s.length > 8 ? s : s + ' ' + (items[i + 1]?.str ?? '') + (items[i + 2]?.str ?? '');
    if (/^(Figure|Fig\.|Table)\s*[A-Z]?\d+(\.\d+)?\s*[:.]/.test(rest)) return true;
  }
  return false;
}

async function readOutline(pdf: PDFDocumentProxy): Promise<OutlineEntry[]> {
  const out: OutlineEntry[] = [];
  let outline: any[] | null = null;
  try {
    outline = await pdf.getOutline();
  } catch {
    return out;
  }
  const walk = async (items: any[], level: number) => {
    for (const it of items) {
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          const pageIndex = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
          const page = await pdf.getPage(pageIndex + 1);
          const vt = page.getViewport({ scale: 1 }).transform;
          const kind = dest[1]?.name;
          const top = kind === 'XYZ' ? dest[3] : kind === 'FitH' || kind === 'FitBH' ? dest[2] : null;
          const y = typeof top === 'number' ? vt[3] * top + vt[5] : null;
          out.push({ title: it.title, level, page: pageIndex, y });
        }
      } catch {
        // Unresolvable destination: skip the entry.
      }
      if (it.items?.length) await walk(it.items, level + 1);
    }
  };
  if (outline) await walk(outline, 1);
  return out;
}

/** "version 3.5" on the title page, else "v3.5" in the file name, else the file name. */
function detectLabel(doc: DocModel, name: string): string {
  for (const l of doc.lines) {
    if (l.page > 0) break;
    const m = /\b(?:version|draft)\s*v?(\d+(?:\.\d+)*)\b/i.exec(l.text);
    if (m) return `v${m[1]}`;
  }
  const m = /(?:^|[^a-z])v(\d+(?:[._]\d+)*)/i.exec(name);
  if (m) return `v${m[1].replace('_', '.')}`;
  return name.replace(/\.pdf$/i, '');
}
