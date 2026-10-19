import { PDFDocument, PDFHexString, PDFString, rgb, type RGB } from '@pdfme/pdf-lib';
import type { Alignment, Change } from '../align/align';
import type { DocModel, Rect } from '../extract/types';
import { apply, type Matrix } from '../extract/geometry';
import { changeRuns } from '../ui/marks';
import { TINTS, TONES } from './sideBySide';

// Viewers multiply highlight colours with the page at full strength, so each tone is
// its viewer tint (TONES at TINTS opacity) pre-mixed with white: the same look as on screen.
const HIGHLIGHT: Record<string, RGB> = Object.fromEntries(
  Object.entries(TINTS).map(([tone, a]) => {
    const c = TONES[tone === 'edit' ? 'ins' : tone];
    return [tone, rgb(1 - a * (1 - c.red), 1 - a * (1 - c.green), 1 - a * (1 - c.blue))];
  }),
);

export type AnnotationType = 'Highlight' | 'Underline' | 'Caret' | 'Square' | 'Text';

export interface AnnotationSpec {
  page: number;
  type: AnnotationType;
  /** Rectangles in viewer coordinates (top-left origin) of that page. */
  rects: Rect[];
  tone: string;
  contents: string;
}

const segText = (segs: { text: string; changed: boolean }[]) =>
  segs
    .filter((s) => s.changed)
    .map((s) => s.text)
    .join(' ');

/** Annotations for text changes, as they appear in the new version. */
export function textChangeSpecs(B: DocModel, al: Alignment, changes: Change[]): AnnotationSpec[] {
  const out: AnnotationSpec[] = [];
  for (const c of changes) {
    const oldText = segText(c.aSegs);
    const tone = c.kind === 'moved' ? 'mv' : c.cls === 'numeric' ? 'num' : c.cls === 'renumber' || c.cls === 'toc' ? 'ren' : c.kind === 'insert' ? 'ins' : 'edit';
    let contents: string;
    if (c.kind === 'moved') contents = `Moved here from old page ${c.aPage + 1}${c.move ? `, where it followed “… ${c.move.afterA}”` : ''}.`;
    else if (c.kind === 'insert') contents = 'Added.';
    else if (c.kind === 'delete') contents = `Removed: “${oldText}”`;
    else if (c.cls === 'numeric') contents = `Number changed. Was: “${oldText}”`;
    else if (c.cls === 'renumber') contents = `Renumbered. Was: “${oldText}”`;
    else contents = `Changed. Was: “${oldText}”`;

    if (!c.bTokens.length) {
      out.push({ page: c.bPage, type: 'Caret', rects: [c.bBox], tone: 'del', contents });
      continue;
    }
    // One annotation per page, with the viewer's rectangles. Moved text is underlined,
    // as in the viewer.
    const byPage = new Map<number, Rect[]>();
    for (const r of changeRuns(B, al.tokensB, c.bTokens)) {
      if (!byPage.has(r.page)) byPage.set(r.page, []);
      byPage.get(r.page)!.push(r.box);
    }
    for (const [page, rects] of byPage) out.push({ page, type: tone === 'mv' ? 'Underline' : 'Highlight', rects, tone, contents });
  }
  return out;
}

function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** Rectangle corners in PDF user space: [upper-left, upper-right, lower-left, lower-right]. */
export function toUserQuad(transform: Matrix, r: Rect): [number, number][] {
  const inv = invert(transform);
  return [apply(inv, r[0], r[1]), apply(inv, r[2], r[1]), apply(inv, r[0], r[3]), apply(inv, r[2], r[3])];
}

/**
 * The new version with the changes as standard PDF annotations (highlights
 * with "was: …" notes, underlines for moved text, carets for deletions, boxes around changed figures).
 * Readable in any PDF viewer; the original pages are untouched.
 */
export async function buildAnnotated(bytes: ArrayBuffer, B: DocModel, specs: AnnotationSpec[], subject: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const now = PDFString.fromDate(new Date());
  const author = PDFHexString.fromText('PDF diff');
  specs.forEach((sp, n) => {
    const page = pages[sp.page];
    if (!page || !sp.rects.length) return;
    const quads = sp.rects.map((r) => toUserQuad(B.pages[sp.page].transform as Matrix, r));
    const xs = quads.flat().map((p) => p[0]);
    const ys = quads.flat().map((p) => p[1]);
    let rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const c = (sp.type === 'Highlight' ? HIGHLIGHT[sp.tone] : undefined) ?? TONES[sp.tone] ?? TONES.edit;
    const color = [c.red, c.green, c.blue];
    const base: Record<string, unknown> = {
      Type: 'Annot',
      Subtype: sp.type,
      C: color,
      Contents: PDFHexString.fromText(sp.contents),
      T: author,
      M: now,
      NM: PDFHexString.fromText(`pdfdiff-${n}`),
      F: 4,
    };
    if (sp.type === 'Highlight' || sp.type === 'Underline') base.QuadPoints = quads.flatMap((q) => q.flat());
    else if (sp.type === 'Caret') rect = [rect[0] - 3, rect[1], rect[2] + 3, rect[3]];
    else if (sp.type === 'Square') base.BS = { W: 1.5, S: 'D', D: [3, 2] };
    else if (sp.type === 'Text') {
      rect = [rect[0], rect[3] - 18, rect[0] + 18, rect[3]];
      base.Name = 'Comment';
      base.Open = false;
    }
    base.Rect = rect;
    page.node.addAnnot(doc.context.register(doc.context.obj(base as never)));
  });
  doc.setSubject(subject);
  return doc.save();
}
