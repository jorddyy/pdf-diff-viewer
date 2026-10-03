import type { Piece } from './types';

export interface LineMark {
  page: number;
  base: number;
  num: number;
}

export interface LineNumberResult {
  found: boolean;
  /** Pieces that are line numbers; they are removed from the text. */
  pieces: Set<Piece>;
  /** Marks per page, sorted by baseline. */
  marks: LineMark[][];
}

/**
 * Find the column of line numbers printed by the lineno package: integers in
 * the left or right margin, aligned on one edge, increasing by one in reading
 * order (also across pages). Returns found=false for documents without them.
 */
export function detectLineNumbers(pagePieces: Piece[][], bodyLeft: number, bodyRight: number): LineNumberResult {
  interface Cand {
    page: number;
    piece: Piece;
    num: number;
  }
  const clusters = new Map<string, Cand[]>();
  pagePieces.forEach((pieces, page) => {
    for (const p of pieces) {
      if (!/^\d{1,5}$/.test(p.text)) continue;
      let keys: string[];
      if (p.x1 < bodyLeft - 2) keys = [`L1:${Math.round(p.x1 / 2)}`, `L0:${Math.round(p.x0 / 2)}`];
      else if (p.x0 > bodyRight + 2) keys = [`R0:${Math.round(p.x0 / 2)}`, `R1:${Math.round(p.x1 / 2)}`];
      else continue;
      for (const k of keys) {
        let list = clusters.get(k);
        if (!list) clusters.set(k, (list = []));
        list.push({ page, piece: p, num: +p.text });
      }
    }
  });

  let best: { key: string; score: number } | null = null;
  for (const [key, list] of clusters) {
    if (list.length < 15) continue;
    const sorted = [...list].sort((a, b) => a.page - b.page || a.piece.base - b.piece.base);
    let consecutive = 0;
    for (let i = 1; i < sorted.length; i++) if (sorted[i].num === sorted[i - 1].num + 1) consecutive++;
    const frac = consecutive / (sorted.length - 1);
    if (frac < 0.6) continue;
    if (!best || consecutive > best.score) best = { key, score: consecutive };
  }

  const marks: LineMark[][] = pagePieces.map(() => []);
  const pieces = new Set<Piece>();
  if (!best) return { found: false, pieces, marks };

  // Accept the winning bucket and its immediate neighbours (sub-point jitter).
  const [side, bucketStr] = best.key.split(':');
  const bucket = +bucketStr;
  for (const b of [bucket - 1, bucket, bucket + 1]) {
    for (const c of clusters.get(`${side}:${b}`) ?? []) {
      if (pieces.has(c.piece)) continue;
      pieces.add(c.piece);
      marks[c.page].push({ page: c.page, base: c.piece.base, num: c.num });
    }
  }
  for (const m of marks) m.sort((a, b) => a.base - b.base);
  return { found: true, pieces, marks };
}
