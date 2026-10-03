import { TokState, type Alignment } from '../align/align';
import type { DocModel } from '../extract/types';

export interface PagePair {
  a: number | null;
  b: number | null;
}

/**
 * Which old page to show next to each new page: the one most of its
 * unchanged text comes from. Old pages that end up next to no new page
 * (removed material) are inserted after the pair with the closest earlier
 * old page, with an empty partner.
 */
export function pairPages(nA: number, nB: number, links: [b: number, a: number][]): PagePair[] {
  const votes: Map<number, number>[] = Array.from({ length: nB }, () => new Map());
  for (const [b, a] of links) votes[b]?.set(a, (votes[b].get(a) ?? 0) + 1);
  const pairs: PagePair[] = [];
  for (let b = 0; b < nB; b++) {
    let best: number | null = null;
    let bestN = 0;
    for (const [a, n] of votes[b]) {
      if (n > bestN || (n === bestN && best !== null && a < best)) {
        best = a;
        bestN = n;
      }
    }
    pairs.push({ a: best, b });
  }
  const used = new Set(pairs.map((p) => p.a).filter((a): a is number => a !== null));
  for (let a = 0; a < nA; a++) {
    if (used.has(a)) continue;
    // After the last pair showing an earlier old page.
    let at = 0;
    for (let i = 0; i < pairs.length; i++) if (pairs[i].a !== null && pairs[i].a! < a) at = i + 1;
    pairs.splice(at, 0, { a, b: null });
  }
  return pairs;
}

/** Unchanged-text links (new page, old page) from an alignment, one per line. */
export function alignmentLinks(A: DocModel, B: DocModel, al: Alignment): [number, number][] {
  const out: [number, number][] = [];
  let lastLine = -1;
  for (let t = 0; t < al.tokensB.length; t++) {
    if (al.bState[t] !== TokState.Equal || al.bToA[t] < 0) continue;
    const tb = al.tokensB[t];
    if (tb.line === lastLine) continue;
    lastLine = tb.line;
    out.push([B.lines[tb.line].page, A.lines[al.tokensA[al.bToA[t]].line].page]);
  }
  return out;
}
