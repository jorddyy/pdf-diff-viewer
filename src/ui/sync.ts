import { TokState, type Alignment } from '../align/align';
import type { DocModel } from '../extract/types';
import type { Side } from './marks';

export interface Pos {
  page: number;
  y: number;
}

/**
 * Correspondence between the two documents for synchronised scrolling, in
 * continuous document coordinates (points from the top of page 1, pages
 * stacked). Anchor arrays are strictly increasing in both documents, so the
 * mapping is monotone and has no jumps at page breaks or figures.
 */
export interface SyncMap {
  a: number[];
  b: number[];
  cumA: number[];
  cumB: number[];
}

function cumulative(doc: DocModel): number[] {
  const cum = [0];
  for (const p of doc.pages) cum.push(cum[cum.length - 1] + p.height);
  return cum;
}

export function buildSyncMap(A: DocModel, B: DocModel, al: Alignment): SyncMap {
  const cumA = cumulative(A);
  const cumB = cumulative(B);
  // One anchor per old line whose text is unchanged in the new version.
  const pairs: [number, number][] = [];
  let lastLine = -1;
  for (let t = 0; t < al.tokensA.length; t++) {
    if (al.aState[t] !== TokState.Equal) continue;
    const ta = al.tokensA[t];
    if (ta.line === lastLine) continue;
    lastLine = ta.line;
    const la = A.lines[ta.line];
    const lb = B.lines[al.tokensB[al.aToB[t]].line];
    // Floats sit wherever LaTeX put them; only running text says where we are.
    if (la.kind === 'caption' || la.kind === 'table') continue;
    pairs.push([cumA[la.page] + la.box[1], cumB[lb.page] + lb.box[1]]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  const chain = increasingChain(pairs);
  return { a: chain.map((p) => p[0]), b: chain.map((p) => p[1]), cumA, cumB };
}

/** Longest chain strictly increasing in both coordinates (pairs sorted by the first). */
function increasingChain(pairs: [number, number][]): [number, number][] {
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    if (i > 0 && pairs[i][0] === pairs[i - 1][0]) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < pairs[i][1]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out: [number, number][] = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.push(pairs[i]);
  return out.reverse();
}

function toDoc(cum: number[], p: Pos): number {
  return (cum[p.page] ?? cum[cum.length - 1]) + p.y;
}

function fromDoc(cum: number[], v: number): Pos {
  let page = 0;
  while (page + 2 < cum.length && cum[page + 1] <= v) page++;
  return { page, y: v - cum[page] };
}

/** Map a position on one side to the corresponding position on the other. */
export function mapPos(map: SyncMap, from: Side, p: Pos): Pos | null {
  const [src, dst, cumSrc, cumDst] = from === 'a' ? [map.a, map.b, map.cumA, map.cumB] : [map.b, map.a, map.cumB, map.cumA];
  if (!src.length) return null;
  const v = toDoc(cumSrc, p);
  let lo = 0;
  let hi = src.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (src[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  let out: number;
  if (lo === 0) out = dst[0] + (v - src[0]);
  else if (lo === src.length) out = dst[src.length - 1] + (v - src[src.length - 1]);
  else {
    const f = (v - src[lo - 1]) / (src[lo] - src[lo - 1]);
    out = dst[lo - 1] + f * (dst[lo] - dst[lo - 1]);
  }
  return fromDoc(cumDst, Math.max(0, out));
}
