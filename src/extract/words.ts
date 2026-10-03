import type { Piece, TextQuality } from './types';
import { apply, type Matrix } from './geometry';
import { isSuspiciousChar, repairText } from './normalize';

// Approximate Computer Modern advance widths (em) for printable ASCII, used to
// place word boundaries inside a pdf.js text run. pdf.js only reports the
// width of the whole run, so this is an estimate, but far better than
// assuming every character has the same width.
const CM_WIDTHS: Record<string, number> = {};
(() => {
  const set = (chars: string, w: number) => {
    for (const c of chars) CM_WIDTHS[c] = w;
  };
  set('abdghnopquvxy0123456789$/^_~\\{}*"', 0.53);
  set('ceksz', 0.44);
  set('fjrt', 0.36);
  set('il.,:;!|\'[]', 0.278);
  set('m', 0.833);
  set('w', 0.722);
  set('()', 0.389);
  set('-', 0.333);
  set('?', 0.472);
  set('ABDEFGHKLNOPQRTUVXYZCJ', 0.74);
  set('I', 0.361);
  set('M', 0.917);
  set('W', 1.028);
  set('S', 0.556);
  set('=+<>%&#@', 0.778);
  set(' ', 0.333);
})();

function charWidth(c: string): number {
  return CM_WIDTHS[c] ?? 0.6;
}

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  fontName: string;
}

interface StyleLike {
  ascent?: number;
  descent?: number;
}

/**
 * Split pdf.js text items into whitespace-free pieces with estimated boxes.
 * Rotated text (axis labels, margin stamps) is skipped.
 */
export function itemsToPieces(
  items: unknown[],
  styles: Record<string, StyleLike>,
  viewportTransform: Matrix,
  quality: TextQuality,
): Piece[] {
  const pieces: Piece[] = [];
  let pendingSpace = true;
  for (const raw of items) {
    const item = raw as TextItemLike;
    if (typeof item.str !== 'string' || item.str.length === 0) continue;
    const str = repairText(item.str);
    if (!/\S/.test(str)) {
      pendingSpace = true;
      continue;
    }
    const t = item.transform;
    if (Math.abs(t[1]) > 1e-3 || Math.abs(t[2]) > 1e-3) {
      pendingSpace = true;
      continue;
    }
    for (const ch of str) {
      if (/\s/.test(ch)) continue;
      quality.glyphs++;
      if (isSuspiciousChar(ch)) quality.suspicious++;
    }
    const size = Math.abs(t[3]) || Math.abs(t[0]);
    const [x, base] = apply(viewportTransform, t[4], t[5]);
    const width = item.width * Math.abs(viewportTransform[0] || 1);
    const style = styles[item.fontName] ?? {};
    const ascent = style.ascent && style.ascent > 0 ? style.ascent : 0.75;
    const descent = style.descent && style.descent < 0 ? -style.descent : 0.25;

    const chars = [...str];
    const weights = chars.map(charWidth);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let cum = 0;
    let runStart = -1;
    let runX0 = 0;
    let sawSpace = pendingSpace;
    const flush = (endX: number, endIdx: number) => {
      pieces.push({
        text: chars.slice(runStart, endIdx).join(''),
        x0: runX0,
        x1: endX,
        base,
        size,
        top: base - ascent * size,
        bottom: base + descent * size,
        spaceBefore: sawSpace,
      });
      runStart = -1;
      sawSpace = false;
    };
    for (let i = 0; i < chars.length; i++) {
      const cx = x + (cum / total) * width;
      if (/\s/.test(chars[i])) {
        if (runStart >= 0) flush(cx, i);
        sawSpace = true;
      } else if (runStart < 0) {
        runStart = i;
        runX0 = cx;
      }
      cum += weights[i];
    }
    if (runStart >= 0) flush(x + width, chars.length);
    pendingSpace = /\s$/.test(str);
  }
  return pieces;
}
