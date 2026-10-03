import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNull,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFEmbeddedPage,
  type PDFFont,
  type PDFPage,
  type RGB,
} from '@pdfme/pdf-lib';
import { multiply, type Matrix } from '../extract/geometry';
import type { PageInfo } from '../extract/types';
import type { Mark } from '../ui/marks';
import { alignmentLinks, pairPages } from './pairing';
import { clip, winAnsi } from './text';
import type { ExportInput, ExportSide, SummaryItem } from './types';

const MARGIN = 24;
const GUTTER = 24;
const HEADER = 30;

export const TONES: Record<string, RGB> = {
  del: rgb(0.86, 0.15, 0.15),
  ins: rgb(0.09, 0.64, 0.29),
  edit: rgb(0.18, 0.36, 0.84),
  num: rgb(0.92, 0.54, 0),
  mv: rgb(0.49, 0.23, 0.93),
  ren: rgb(0.39, 0.45, 0.55),
  toc: rgb(0.39, 0.45, 0.55),
  fig: rgb(0.92, 0.54, 0),
  cmt: rgb(0.18, 0.36, 0.84),
};

/**
 * A PDF with the old page next to the matching new page on every sheet, the
 * changes highlighted, and a list of all changes (with links) in front.
 * Pages are embedded as vector graphics, so text stays sharp.
 */
export async function buildSideBySide(input: ExportInput): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setTitle(winAnsi(`${input.title}: ${input.A.label} vs ${input.B.label}`));
  out.setCreator('PDF diff viewer');
  out.setProducer('PDF diff viewer (pdf-lib)');
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);

  const [srcA, srcB] = await Promise.all([
    PDFDocument.load(input.A.bytes, { ignoreEncryption: true, updateMetadata: false }),
    PDFDocument.load(input.B.bytes, { ignoreEncryption: true, updateMetadata: false }),
  ]);
  const embA = await out.embedPdf(srcA, range(srcA.getPageCount()));
  const embB = await out.embedPdf(srcB, range(srcB.getPageCount()));

  const pairs = pairPages(input.A.doc.numPages, input.B.doc.numPages, alignmentLinks(input.A.doc, input.B.doc, input.al));

  // Summary pages come first, but link to the sheets, so reserve them now.
  const lines = summaryLines(input);
  const perPage = 58;
  const summary: PDFPage[] = [];
  for (let i = 0; i < Math.max(1, Math.ceil(lines.length / perPage)); i++) summary.push(out.addPage([595.28, 841.89]));

  const sheetOfB = new Map<number, PDFPage>();
  const sheetOfA = new Map<number, PDFPage>();
  for (const pr of pairs) {
    const pa = pr.a !== null ? input.A.doc.pages[pr.a] : null;
    const pb = pr.b !== null ? input.B.doc.pages[pr.b] : null;
    const wa = (pa ?? pb!).width;
    const wb = (pb ?? pa!).width;
    const h = Math.max(pa?.height ?? 0, pb?.height ?? 0);
    const W = MARGIN + wa + GUTTER + wb + MARGIN;
    const H = HEADER + h + MARGIN;
    const sheet = out.addPage([W, H]);
    const left = MARGIN;
    const right = MARGIN + wa + GUTTER;
    drawSide(sheet, input.A, pr.a, pa, embA, left, H, wa, h, font, bold);
    drawSide(sheet, input.B, pr.b, pb, embB, right, H, wb, h, font, bold);
    if (pr.b !== null && !sheetOfB.has(pr.b)) sheetOfB.set(pr.b, sheet);
    if (pr.a !== null && !sheetOfA.has(pr.a)) sheetOfA.set(pr.a, sheet);
  }

  // Fill the summary pages.
  lines.forEach((ln, i) => {
    const page = summary[Math.floor(i / perPage)];
    const y = 841.89 - 50 - (i % perPage) * 13;
    const x = 50;
    const f = ln.bold ? bold : font;
    const size = ln.size ?? 9;
    if (ln.tone) {
      page.drawText(winAnsi(ln.badge ?? ''), { x, y, size: 7.5, font: bold, color: TONES[ln.tone] ?? TONES.edit });
    }
    const tx = ln.tone ? x + 78 : x;
    const maxW = 595.28 - 50 - tx;
    page.drawText(fit(winAnsi(ln.text), f, size, maxW), { x: tx, y, size, font: f, color: ln.muted ? rgb(0.4, 0.4, 0.45) : rgb(0.1, 0.1, 0.12) });
    const target = ln.item ? (ln.item.bPage !== null ? sheetOfB.get(ln.item.bPage) : null) ?? (ln.item.aPage !== null ? sheetOfA.get(ln.item.aPage) : null) : null;
    if (target) link(out, page, [x - 2, y - 3, 595.28 - 48, y + 10], target);
  });

  return out.save();
}

interface Line {
  text: string;
  bold?: boolean;
  muted?: boolean;
  size?: number;
  tone?: string;
  badge?: string;
  item?: SummaryItem;
}

function summaryLines(input: ExportInput): Line[] {
  const lines: Line[] = [
    { text: input.title, bold: true, size: 14 },
    { text: '' },
    { text: `Old: ${input.A.label}  (${input.A.name}, ${input.A.doc.numPages} pages)` },
    { text: `New: ${input.B.label}  (${input.B.name}, ${input.B.doc.numPages} pages)` },
    { text: `Made on ${new Date().toLocaleString()} with the PDF diff viewer, ${input.appUrl}`, muted: true },
    { text: 'On every following sheet the old page is on the left and the matching new page on the right.', muted: true },
    {
      text: 'Red: removed, green: added, orange: numbers or figures changed, purple: moved. Click a line below to go to its sheet.',
      muted: true,
    },
    { text: '' },
    { text: `Changes (${input.items.length})`, bold: true, size: 11 },
  ];
  let section = '\u0000';
  for (const it of input.items) {
    if (it.section !== section) {
      section = it.section;
      lines.push({ text: section || 'Front matter', bold: true, size: 8.5, muted: true });
    }
    lines.push({ text: `${it.pages}   ${it.text}`, tone: it.tone, badge: it.badge, item: it });
  }
  if (input.comments.length) {
    lines.push({ text: '' }, { text: `Review comments (${input.comments.length})`, bold: true, size: 11 });
    for (const it of input.comments) lines.push({ text: `${it.pages}   ${it.text}`, tone: it.tone, badge: it.badge, item: it });
  }
  return lines;
}

function drawSide(
  sheet: PDFPage,
  side: ExportSide,
  index: number | null,
  info: PageInfo | null,
  emb: PDFEmbeddedPage[],
  ox: number,
  H: number,
  w: number,
  h: number,
  font: PDFFont,
  bold: PDFFont,
): void {
  const label = index !== null ? `${side.label}  page ${index + 1}` : `${side.label}  (no matching page)`;
  sheet.drawText(winAnsi(label), { x: ox, y: H - 20, size: 10, font: bold, color: rgb(0.2, 0.2, 0.25) });
  if (index === null || !info) {
    sheet.drawRectangle({ x: ox, y: H - HEADER - h, width: w, height: h, borderColor: rgb(0.75, 0.75, 0.78), borderWidth: 1, borderDashArray: [4, 4] });
    sheet.drawText('Nothing here corresponds to the page on the other side.', { x: ox + 20, y: H - HEADER - 40, size: 10, font, color: rgb(0.5, 0.5, 0.55) });
    return;
  }
  // Page placed via its viewport transform (handles /Rotate), top-left at (ox, HEADER).
  const name = sheet.node.newXObject('Pg', emb[index].ref);
  const m = multiply(info.transform as Matrix, [1, 0, 0, -1, ox, H - HEADER]);
  sheet.pushOperators(pushGraphicsState(), concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]), drawObject(name), popGraphicsState());
  sheet.drawRectangle({ x: ox, y: H - HEADER - info.height, width: info.width, height: info.height, borderColor: rgb(0.8, 0.8, 0.82), borderWidth: 0.5 });
  for (const mk of side.marks.get(index) ?? []) drawMark(sheet, mk, ox, H - HEADER, bold);
}

/** A mark of the viewer, drawn in PDF coordinates (top of the page at `top`). */
export function drawMark(page: PDFPage, mk: Mark, ox: number, top: number, bold: PDFFont): void {
  const [x0, y0, x1, y1] = mk.box;
  const cls = mk.cls.split(' ');
  const x = ox + x0;
  const y = top - y1;
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  if (cls.includes('cpin')) return;
  if (cls.includes('caret')) {
    const c = TONES[cls.includes('ins') ? 'ins' : 'del'];
    page.drawRectangle({ x: x - 0.8, y, width: 1.6, height, color: c });
    return;
  }
  if (cls.includes('fig')) {
    const state = cls.find((c) => ['same', 'changed', 'new', 'removed', 'pending'].includes(c)) ?? 'changed';
    const c = state === 'new' ? TONES.ins : state === 'removed' ? TONES.del : state === 'same' || state === 'pending' ? TONES.ren : TONES.fig;
    page.drawRectangle({ x, y, width, height, borderColor: c, borderWidth: state === 'same' ? 0.6 : 1.6, borderDashArray: [4, 3] });
    if (mk.label) {
      const text = winAnsi(mk.label);
      const tw = bold.widthOfTextAtSize(text, 7) + 6;
      page.drawRectangle({ x, y: y + height + 1, width: tw, height: 10, color: c });
      page.drawText(text, { x: x + 3, y: y + height + 3.5, size: 7, font: bold, color: rgb(1, 1, 1) });
    }
    return;
  }
  if (cls.includes('cmt')) {
    page.drawRectangle({ x, y, width, height, borderColor: TONES.cmt, borderWidth: 1.2, color: TONES.cmt, opacity: 0.08 });
    return;
  }
  const tone = cls.find((c) => TONES[c]) ?? 'edit';
  page.drawRectangle({ x, y, width, height, color: TONES[tone], opacity: tone === 'ren' || tone === 'toc' ? 0.18 : 0.28 });
}

function link(out: PDFDocument, page: PDFPage, rect: number[], target: PDFPage): void {
  const dest = PDFArray.withContext(out.context);
  dest.push(target.ref);
  dest.push(PDFName.of('XYZ'));
  dest.push(PDFNull);
  dest.push(PDFNull);
  dest.push(PDFNull);
  const annot = out.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], Dest: dest });
  page.node.addAnnot(out.context.register(annot));
}

function fit(text: string, font: PDFFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (font.widthOfTextAtSize(clip(text, mid), size) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return clip(text, lo);
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
