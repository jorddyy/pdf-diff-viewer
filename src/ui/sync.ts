import { TokState, type Alignment } from '../align/align';
import type { DocModel } from '../extract/types';
import type { Side } from './marks';

export interface Pos {
  page: number;
  y: number;
}

interface Anchor {
  a: Pos;
  b: Pos;
}

/** One anchor per line of the old document whose text is unchanged in the new one. */
export function buildAnchors(A: DocModel, B: DocModel, al: Alignment): { byA: Anchor[]; byB: Anchor[] } {
  const anchors: Anchor[] = [];
  let lastLine = -1;
  for (let t = 0; t < al.tokensA.length; t++) {
    if (al.aState[t] !== TokState.Equal) continue;
    const ta = al.tokensA[t];
    if (ta.line === lastLine) continue;
    lastLine = ta.line;
    const tb = al.tokensB[al.aToB[t]];
    const la = A.lines[ta.line];
    const lb = B.lines[tb.line];
    anchors.push({ a: { page: la.page, y: la.box[1] }, b: { page: lb.page, y: lb.box[1] } });
  }
  const key = (p: Pos) => p.page * 1e5 + p.y;
  const byA = [...anchors].sort((x, y) => key(x.a) - key(y.a));
  const byB = [...anchors].sort((x, y) => key(x.b) - key(y.b));
  return { byA, byB };
}

/** Map a position on one side to the corresponding position on the other, interpolating between anchors. */
export function mapPos(anchors: { byA: Anchor[]; byB: Anchor[] }, from: Side, p: Pos): Pos | null {
  const list = from === 'a' ? anchors.byA : anchors.byB;
  if (!list.length) return null;
  const src = (x: Anchor) => (from === 'a' ? x.a : x.b);
  const dst = (x: Anchor) => (from === 'a' ? x.b : x.a);
  const key = (q: Pos) => q.page * 1e5 + q.y;
  const k = key(p);
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(src(list[mid])) < k) lo = mid + 1;
    else hi = mid;
  }
  const after = list[Math.min(lo, list.length - 1)];
  const before = list[Math.max(lo - 1, 0)];
  const s0 = src(before);
  const s1 = src(after);
  const d0 = dst(before);
  const d1 = dst(after);
  if (s0.page === s1.page && d0.page === d1.page && s1.y > s0.y) {
    const f = Math.min(1, Math.max(0, (p.y - s0.y) / (s1.y - s0.y)));
    return { page: d0.page, y: d0.y + f * (d1.y - d0.y) };
  }
  // Across a page break: keep the offset from the nearest anchor.
  const near = Math.abs(key(s0) - k) <= Math.abs(key(s1) - k) ? before : after;
  const s = src(near);
  const d = dst(near);
  return s.page === p.page ? { page: d.page, y: d.y + (p.y - s.y) } : { page: d.page, y: d.y };
}
