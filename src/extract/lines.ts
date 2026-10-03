import type { Piece, Rect } from './types';
import type { LineMark } from './linenumbers';

export interface RawWord {
  text: string;
  box: Rect;
}

export interface RawLine {
  page: number;
  base: number;
  size: number;
  box: Rect;
  num: number | null;
  words: RawWord[];
  text: string;
}

interface Row {
  pieces: Piece[];
  base: number;
  size: number;
  x0: number;
  x1: number;
}

/**
 * Group the pieces of one page into lines. Sub- and superscripts sit on their
 * own baseline, so they are attached to the nearest "main" row. With line
 * numbers, each numbered baseline defines a main row; otherwise rows with a
 * reasonable amount of body-size text do.
 */
export function buildLines(page: number, pieces: Piece[], marks: LineMark[], bodySize: number): RawLine[] {
  // TeX places the radical sign by its top; move it onto the radicand's baseline.
  const adjusted = pieces.map((p) =>
    p.text.startsWith('\u221a') ? { ...p, base: p.base + 0.72 * p.size, top: p.top + 0.72 * p.size, bottom: p.bottom + 0.72 * p.size } : p,
  );
  let rows = groupRows(adjusted);

  const anchored = new Map<Row, LineMark>();
  for (const m of marks) {
    let best: Row | null = null;
    for (const r of rows) {
      if (Math.abs(m.base - r.base) > Math.max(2, 0.3 * r.size)) continue;
      if (!best || r.size > best.size + 0.5 || (Math.abs(r.size - best.size) <= 0.5 && Math.abs(m.base - r.base) < Math.abs(m.base - best.base))) best = r;
    }
    if (best && !anchored.has(best)) anchored.set(best, m);
  }
  const isMain = (r: Row) => {
    if (marks.length) return anchored.has(r);
    const chars = r.pieces.reduce((n, p) => n + p.text.length, 0);
    return chars >= 20 || (chars >= 8 && r.pieces.some((p) => p.size >= 0.9 * bodySize));
  };
  const main = rows.filter(isMain);
  const leftover: Piece[] = [];
  for (const r of rows) {
    if (isMain(r)) continue;
    for (const p of r.pieces) {
      let target: Row | null = null;
      let bestD = Infinity;
      for (const n of main) {
        const d = Math.abs(p.base - n.base);
        const limit = p.size <= 0.85 * n.size ? 0.62 * n.size : 0.3 * n.size;
        const pad = 0.8 * n.size;
        if (d > limit || p.x0 < n.x0 - pad || p.x1 > n.x1 + pad) continue;
        if (d < bestD) {
          bestD = d;
          target = n;
        }
      }
      if (target) target.pieces.push(p);
      else leftover.push(p);
    }
  }
  rows = [...main, ...foldScripts(groupRows(leftover))].sort((a, b) => a.base - b.base);

  return rows.map((r) => {
    const m = anchored.get(r);
    const words = piecesToWords(r.pieces);
    let box: Rect | null = null;
    for (const w of words) box = box ? [Math.min(box[0], w.box[0]), Math.min(box[1], w.box[1]), Math.max(box[2], w.box[2]), Math.max(box[3], w.box[3])] : ([...w.box] as Rect);
    return {
      page,
      base: r.base,
      size: r.size,
      box: box ?? [r.x0, r.base - r.size, r.x1, r.base],
      num: m ? m.num : null,
      words,
      text: words.map((w) => w.text).join(' '),
    };
  });
}

function groupRows(pieces: Piece[]): Row[] {
  const sorted = [...pieces].sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const rows: Row[] = [];
  for (const p of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(p.base - row.base) <= 0.8) {
      row.pieces.push(p);
      row.size = Math.max(row.size, p.size);
      row.x0 = Math.min(row.x0, p.x0);
      row.x1 = Math.max(row.x1, p.x1);
    } else {
      rows.push({ pieces: [p], base: p.base, size: p.size, x0: p.x0, x1: p.x1 });
    }
  }
  return rows;
}

/** Fold rows of smaller text (scripts in display maths) into a neighbouring bigger row. */
function foldScripts(rows: Row[]): Row[] {
  const order = [...rows].sort((a, b) => a.size - b.size);
  const merged = new Set<Row>();
  for (const r of order) {
    if (merged.has(r)) continue;
    let target: Row | null = null;
    let bestD = Infinity;
    for (const n of rows) {
      if (n === r || merged.has(n) || r.size > 0.85 * n.size) continue;
      const d = Math.abs(r.base - n.base);
      const pad = 0.6 * n.size;
      if (d > 0.6 * n.size || r.x0 < n.x0 - pad || r.x1 > n.x1 + pad) continue;
      if (d < bestD) {
        bestD = d;
        target = n;
      }
    }
    if (target) {
      target.pieces.push(...r.pieces);
      target.x0 = Math.min(target.x0, r.x0);
      target.x1 = Math.max(target.x1, r.x1);
      merged.add(r);
    }
  }
  return rows.filter((r) => !merged.has(r));
}

/** Merge pieces (sorted by x) into words; a word ends at whitespace or a clear gap. */
export function piecesToWords(pieces: Piece[]): RawWord[] {
  const ps = [...pieces].sort((a, b) => a.x0 - b.x0);
  const words: RawWord[] = [];
  let cur: { text: string; box: Rect; size: number } | null = null;
  for (const p of ps) {
    const box: Rect = [p.x0, p.top, p.x1, p.bottom];
    if (cur) {
      const gap = p.x0 - cur.box[2];
      const size = Math.max(cur.size, p.size);
      if (!p.spaceBefore && gap < 0.25 * size) {
        cur.text += p.text;
        cur.box = [Math.min(cur.box[0], box[0]), Math.min(cur.box[1], box[1]), Math.max(cur.box[2], box[2]), Math.max(cur.box[3], box[3])];
        cur.size = size;
        continue;
      }
      words.push({ text: cur.text, box: cur.box });
    }
    cur = { text: p.text, box, size: p.size };
  }
  if (cur) words.push({ text: cur.text, box: cur.box });
  return words;
}
