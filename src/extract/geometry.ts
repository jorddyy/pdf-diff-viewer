import type { Rect } from './types';

export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Product m1 × m2 in PDF row-vector convention: apply m1 first, then m2. */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function transformRect(m: Matrix, r: Rect): Rect {
  const pts = [apply(m, r[0], r[1]), apply(m, r[2], r[1]), apply(m, r[0], r[3]), apply(m, r[2], r[3])];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function union(a: Rect | null, b: Rect): Rect {
  if (!a) return [...b] as Rect;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function unionAll(rects: Rect[]): Rect | null {
  let u: Rect | null = null;
  for (const r of rects) u = union(u, r);
  return u;
}

export function area(r: Rect): number {
  return Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const r: Rect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[2] > r[0] && r[3] > r[1] ? r : null;
}

export function contains(r: Rect, x: number, y: number, pad = 0): boolean {
  return x >= r[0] - pad && x <= r[2] + pad && y >= r[1] - pad && y <= r[3] + pad;
}

export function overlapX(a: Rect, b: Rect): number {
  return Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Most frequent value after rounding to `step`. */
export function mode(xs: number[], step = 1): number {
  const counts = new Map<number, number>();
  let best = 0;
  let bestCount = 0;
  for (const x of xs) {
    const k = Math.round(x / step) * step;
    const c = (counts.get(k) ?? 0) + 1;
    counts.set(k, c);
    if (c > bestCount) {
      bestCount = c;
      best = k;
    }
  }
  return best;
}
