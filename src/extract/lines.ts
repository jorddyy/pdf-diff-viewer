import type { Piece, Rect } from './types';
import type { LineMark } from './linenumbers';

export interface RawWord {
  text: string;
  box: Rect;
  /** A footnote mark split off its word ("decays¹", "¹The …"). */
  note?: boolean;
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
  // Main rows: numbered lines, plus rows with a fair amount of text (table
  // rows, captions, unnumbered documents) that are not the scripts of a
  // numbered line. The same rule with and without line numbers keeps tables
  // comparable between numbered drafts and the unnumbered final version.
  const textual = (r: Row) => {
    const chars = r.pieces.reduce((n, p) => n + p.text.length, 0);
    return chars >= 20 || (chars >= 8 && r.pieces.some((p) => p.size >= 0.9 * bodySize));
  };
  const nearAnchored = (r: Row) =>
    [...anchored.keys()].some((a) => a !== r && r.size <= 0.85 * a.size && Math.abs(r.base - a.base) <= 0.62 * a.size);
  const mainSet = new Set(rows.filter((r) => anchored.has(r) || (textual(r) && !nearAnchored(r))));
  const main = rows.filter((r) => mainSet.has(r));
  // Attach the remaining pieces (sub/superscripts) left to right to the
  // nearest main row; a script may start right after the row's last glyph,
  // so the row grows as pieces join ("× 10" + "−" + "3").
  const loose = rows.filter((r) => !mainSet.has(r)).flatMap((r) => r.pieces).sort((a, b) => a.x0 - b.x0);
  const leftover: Piece[] = [];
  for (const p of loose) {
    let target: Row | null = null;
    let bestD = Infinity;
    for (const n of main) {
      const d = Math.abs(p.base - n.base);
      const limit = p.size <= 0.85 * n.size ? 0.62 * n.size : 0.3 * n.size;
      // A whole em to the left: a two-digit footnote mark pushes its text that far.
      const pad = n.size;
      if (d > limit || p.x0 < n.x0 - pad || p.x0 > n.x1 + pad) continue;
      if (d < bestD) {
        bestD = d;
        target = n;
      }
    }
    if (target) {
      target.pieces.push(p);
      target.x1 = Math.max(target.x1, p.x1);
    } else leftover.push(p);
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
  let cur: { pieces: Piece[]; raw: string; box: Rect; size: number; note: boolean } | null = null;
  const push = () => {
    if (!cur) return;
    const text = wordText(cur.pieces);
    words.push(cur.note ? { text, box: cur.box, note: true } : { text, box: cur.box });
  };
  for (const p of ps) {
    const box: Rect = [p.x0, p.top, p.x1, p.bottom];
    let note = false;
    if (cur) {
      const gap = p.x0 - cur.box[2];
      const size = Math.max(cur.size, p.size);
      const last: Piece = cur.pieces[cur.pieces.length - 1];
      // Footnote marks are raised digits glued to a word or a sentence end,
      // or opening the footnote text; as words of their own, a footnote
      // added elsewhere does not turn "decays¹" into a changed word.
      const markAfter: boolean = isMark(p, last) && /[a-z]{4}$|[.,;:]$/.test(cur.raw);
      const markBefore: boolean = cur.pieces.length === 1 && isMark(last, p) && /^[A-Za-z]/.test(p.text);
      if (markBefore) cur.note = true;
      if (!p.spaceBefore && gap < 0.25 * size && !markAfter && !markBefore) {
        cur.pieces.push(p);
        cur.raw += p.text;
        cur.box = [Math.min(cur.box[0], box[0]), Math.min(cur.box[1], box[1]), Math.max(cur.box[2], box[2]), Math.max(cur.box[3], box[3])];
        cur.size = size;
        continue;
      }
      note = markAfter;
      push();
    }
    cur = { pieces: [p], raw: p.text, box, size: p.size, note };
  }
  push();
  return words;
}

/**
 * Text of one word. Scripts stacked above each other are read run by run
 * instead of glyph by glyph in x order: an asymmetric uncertainty ("4.52"
 * with "+0.31" over "−0.27") as "4.52+0.31−0.27", not "4.52+0−0..3127".
 */
function wordText(pieces: Piece[]): string {
  // Runs of adjacent pieces on one baseline.
  const runs: { ps: Piece[]; base: number; x0: number; x1: number; size: number }[] = [];
  for (const p of pieces) {
    const run = runs.find((r) => Math.abs(r.base - p.base) < 0.5 && p.x0 - r.x1 < 0.3 * p.size && p.x0 >= r.x1 - 0.3 * p.size);
    if (run) {
      run.ps.push(p);
      run.x1 = Math.max(run.x1, p.x1);
    } else runs.push({ ps: [p], base: p.base, x0: p.x0, x1: p.x1, size: p.size });
  }
  if (runs.length < 2) return pieces.map((p) => p.text).join('');
  // Runs that overlap for most of their width are stacked: they start together.
  const start = runs.map((r) => r.x0);
  for (const a of runs)
    for (const b of runs) {
      const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      if (a !== b && Math.abs(a.base - b.base) > 0.3 * Math.min(a.size, b.size) && overlap > 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0)) {
        const s = Math.min(start[runs.indexOf(a)], start[runs.indexOf(b)]);
        start[runs.indexOf(a)] = start[runs.indexOf(b)] = s;
      }
    }
  // Within a stack the run that starts first leads (TeX shifts a superscript
  // right by the italic correction: "Ds+"); on a tie the upper one.
  const order = runs
    .map((r, i) => ({ r, s: start[i] }))
    .sort((x, y) => x.s - y.s || (Math.abs(x.r.x0 - y.r.x0) > 0.1 ? x.r.x0 - y.r.x0 : x.r.base - y.r.base));
  return order.map(({ r }) => r.ps.map((p) => p.text).join('')).join('');
}

/** A raised one- or two-digit piece in a smaller font than its neighbour. */
function isMark(p: Piece, ref: Piece): boolean {
  return /^\d{1,2}$/.test(p.text) && p.size < 0.8 * ref.size && p.base < ref.base - 0.2 * ref.size;
}
