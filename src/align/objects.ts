import type { DocModel, DocObject, ObjectKind } from '../extract/types';
import { TokState, type Alignment } from './align';

export type FigureStatus = 'identical' | 'changed' | 'pending' | 'added' | 'removed';

export interface PartMatch {
  a: number | null;
  b: number | null;
  /** Equal fingerprints: certainly identical without rendering. */
  sameHash: boolean;
  /** Fraction of ink that differs, once compared visually. */
  diff?: number;
}

export interface ObjectMatch {
  id: number;
  kind: ObjectKind;
  a: number | null;
  b: number | null;
  score: number;
  renumbered: boolean;
  captionChanged: boolean;
  /** Figures only. */
  status: FigureStatus;
  parts: PartMatch[];
}

export interface SectionMatch {
  a: number | null;
  b: number | null;
}

/**
 * Pair figures, tables and equations of two versions. Captions are matched
 * through the text alignment (so renumbered and moved floats are found);
 * figures whose graphics are byte-identical are matched even when the caption
 * was rewritten; the number is the last resort.
 */
export function matchObjects(A: DocModel, B: DocModel, al: Alignment): ObjectMatch[] {
  const votes = new Map<number, Map<number, number>>();
  const sizeA = new Map<number, number>();
  const sizeB = new Map<number, number>();
  al.tokensA.forEach((t, i) => {
    const oa = A.lines[t.line].object;
    if (oa < 0) return;
    sizeA.set(oa, (sizeA.get(oa) ?? 0) + 1);
    const j = al.aToB[i];
    if (j < 0) return;
    const ob = B.lines[al.tokensB[j].line].object;
    if (ob < 0 || A.objects[oa].kind !== B.objects[ob].kind) return;
    let m = votes.get(oa);
    if (!m) votes.set(oa, (m = new Map()));
    m.set(ob, (m.get(ob) ?? 0) + 1);
  });
  al.tokensB.forEach((t) => {
    const ob = B.lines[t.line].object;
    if (ob >= 0) sizeB.set(ob, (sizeB.get(ob) ?? 0) + 1);
  });

  const cands: { a: number; b: number; score: number }[] = [];
  for (const [a, m] of votes) {
    for (const [b, n] of m) {
      const sa = sizeA.get(a) ?? 1;
      const sb = sizeB.get(b) ?? 1;
      let score = n / Math.max(sa, sb);
      // A caption that was reworded and extended: a good share of the old words still found in it.
      if (score < 0.25 && n >= 5 && n / Math.min(sa, sb) >= 0.35) score = 0.25;
      cands.push({ a, b, score });
    }
  }
  // Byte-identical figure graphics.
  const byHash = new Map<string, number[]>();
  for (const o of B.objects) if (o.kind === 'figure') for (const h of o.hashes) if (h) byHash.set(h, [...(byHash.get(h) ?? []), o.id]);
  for (const o of A.objects) {
    if (o.kind !== 'figure') continue;
    for (const h of o.hashes) for (const b of byHash.get(h) ?? []) cands.push({ a: o.id, b, score: 0.6 });
  }
  cands.sort((x, y) => y.score - x.score);

  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: [number, number, number][] = [];
  for (const c of cands) {
    if (c.score < 0.25 || usedA.has(c.a) || usedB.has(c.b)) continue;
    usedA.add(c.a);
    usedB.add(c.b);
    pairs.push([c.a, c.b, c.score]);
  }
  // Captions rewritten so much that the alignment found little: similar wording, in order.
  const loose: { a: number; b: number; score: number }[] = [];
  for (const oa of A.objects) {
    if (usedA.has(oa.id) || oa.kind === 'equation' || !oa.caption) continue;
    for (const ob of B.objects) {
      if (usedB.has(ob.id) || ob.kind !== oa.kind || !ob.caption) continue;
      const s = captionSimilarity(oa, ob);
      if (s >= 0.4) loose.push({ a: oa.id, b: ob.id, score: s - 0.05 * Math.abs(oa.page / A.numPages - ob.page / B.numPages) });
    }
  }
  loose.sort((x, y) => y.score - x.score);
  const chosen: [number, number][] = [];
  for (const c of loose) {
    if (usedA.has(c.a) || usedB.has(c.b)) continue;
    usedA.add(c.a);
    usedB.add(c.b);
    chosen.push([c.a, c.b]);
  }
  // Similar captions of one series (zoomed views, ...) keep their order.
  chosen.sort((x, y) => x[0] - y[0]);
  const sim = (a: number, b: number) => captionSimilarity(A.objects[a], B.objects[b]) >= 0.4;
  for (let i = 0; i < chosen.length; i++)
    for (let j = i + 1; j < chosen.length; j++)
      if (chosen[i][1] > chosen[j][1] && sim(chosen[i][0], chosen[j][1]) && sim(chosen[j][0], chosen[i][1]))
        [chosen[i][1], chosen[j][1]] = [chosen[j][1], chosen[i][1]];
  for (const [a, b] of chosen) pairs.push([a, b, 0]);
  // Same kind and number, both still unmatched.
  for (const oa of A.objects) {
    if (usedA.has(oa.id) || !oa.number) continue;
    const ob = B.objects.find((o) => !usedB.has(o.id) && o.kind === oa.kind && o.number === oa.number && !unrelated(oa, o, A, B));
    if (!ob) continue;
    usedA.add(oa.id);
    usedB.add(ob.id);
    pairs.push([oa.id, ob.id, 0]);
  }

  // Un-numbered graphics (logos, continued floats): same page, overlapping position.
  for (const oa of A.objects) {
    if (usedA.has(oa.id) || oa.kind !== 'figure' || oa.number) continue;
    const ob = B.objects.find((o) => !usedB.has(o.id) && o.kind === 'figure' && !o.number && o.page === oa.page && overlap(o.box, oa.box) > 0.5);
    if (!ob) continue;
    usedA.add(oa.id);
    usedB.add(ob.id);
    pairs.push([oa.id, ob.id, 0]);
  }

  const out: ObjectMatch[] = [];
  const linesA = changedLines(al, 'a');
  const linesB = changedLines(al, 'b');
  const changedA = (o: number) => A.objects[o].lines.some((l) => linesA.has(l));
  const changedB = (o: number) => B.objects[o].lines.some((l) => linesB.has(l));
  for (const [a, b, score] of pairs) {
    const oa = A.objects[a];
    const ob = B.objects[b];
    out.push({
      id: 0,
      kind: oa.kind,
      a,
      b,
      score,
      renumbered: oa.number !== ob.number,
      captionChanged: changedA(a) || changedB(b),
      status: oa.kind === 'figure' ? 'pending' : 'identical',
      parts: oa.kind === 'figure' ? matchParts(A, B, a, b) : [],
    });
  }
  for (const o of A.objects) if (!usedA.has(o.id)) out.push(single(o.kind, o.id, null));
  for (const o of B.objects) if (!usedB.has(o.id)) out.push(single(o.kind, null, o.id));
  for (const m of out) {
    if (m.kind !== 'figure' || m.status !== 'pending') continue;
    if (m.parts.length && m.parts.every((p) => p.sameHash)) m.status = 'identical';
  }
  // Order by position in the new version (removed objects by their old position).
  const pos = (m: ObjectMatch) => (m.b !== null ? B.objects[m.b].page * 1e4 + B.objects[m.b].box[1] : A.objects[m.a!].page * 1e4 + A.objects[m.a!].box[1] - 0.5);
  out.sort((x, y) => pos(x) - pos(y));
  out.forEach((m, i) => (m.id = i));
  return out;
}

function words(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of s.toLowerCase().replace(/^(figure|table|fig\.)\s*\S+/, '').replace(/\(\d+\)/g, ' ').match(/[^\s.,;:()[\]]+/g) ?? []) if (t.length > 1) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Shared caption words (Dice); 0 when a caption is too short to tell. */
function captionSimilarity(a: DocObject, b: DocObject): number {
  const x = words(a.caption);
  const y = words(b.caption);
  const nx = [...x.values()].reduce((s, c) => s + c, 0);
  const ny = [...y.values()].reduce((s, c) => s + c, 0);
  if (nx < 4 || ny < 4) return 0;
  let inter = 0;
  for (const [k, c] of x) inter += Math.min(c, y.get(k) ?? 0);
  return (2 * inter) / (nx + ny);
}

/** Figures and tables with the same number but different captions and places: a coincidence. */
function unrelated(a: DocObject, b: DocObject, A: DocModel, B: DocModel): boolean {
  const nx = words(a.caption).size;
  const ny = words(b.caption).size;
  // A short formula against a long one is not the same formula.
  if (a.kind === 'equation' && (nx < 4) !== (ny < 4)) return true;
  if (nx < 4 || ny < 4) return false;
  const sim = captionSimilarity(a, b);
  // Equation numbers shift all the time, so the place says nothing: only the formula counts.
  if (a.kind === 'equation') return sim < 0.2;
  // Same number is enough evidence only when the captions agree or the object sits at the same place.
  const moved = Math.abs(a.page / A.numPages - b.page / B.numPages);
  return sim < 0.15 || (sim < 0.3 && moved > 0.04);
}

/** Intersection over union of two boxes. */
function overlap(a: number[], b: number[]): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

function single(kind: ObjectKind, a: number | null, b: number | null): ObjectMatch {
  return {
    id: 0,
    kind,
    a,
    b,
    score: 0,
    renumbered: false,
    captionChanged: false,
    status: a === null ? 'added' : 'removed',
    parts: [],
  };
}

/** Lines with a change other than renumbering. */
function changedLines(al: Alignment, side: 'a' | 'b'): Set<number> {
  const tokens = side === 'a' ? al.tokensA : al.tokensB;
  const state = side === 'a' ? al.aState : al.bState;
  const change = side === 'a' ? al.aChange : al.bChange;
  const out = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    if (state[i] === TokState.Equal) continue;
    const c = al.changes[change[i]];
    if (c && c.cls !== 'renumber') out.add(tokens[i].line);
  }
  return out;
}

/** Pair sub-figures: equal fingerprints first, then reading order. */
function matchParts(A: DocModel, B: DocModel, a: number, b: number): PartMatch[] {
  const pa = A.objects[a];
  const pb = B.objects[b];
  const out: PartMatch[] = [];
  const usedB = new Set<number>();
  const matchedA = new Set<number>();
  pa.hashes.forEach((h, i) => {
    if (!h) return;
    const j = pb.hashes.findIndex((x, k) => x === h && !usedB.has(k));
    if (j < 0) return;
    usedB.add(j);
    matchedA.add(i);
    out.push({ a: i, b: j, sameHash: true });
  });
  const restA = pa.parts.map((_, i) => i).filter((i) => !matchedA.has(i));
  const restB = pb.parts.map((_, j) => j).filter((j) => !usedB.has(j));
  const n = Math.min(restA.length, restB.length);
  for (let k = 0; k < n; k++) out.push({ a: restA[k], b: restB[k], sameHash: false });
  for (const i of restA.slice(n)) out.push({ a: i, b: null, sameHash: false });
  for (const j of restB.slice(n)) out.push({ a: null, b: j, sameHash: false });
  return out.sort((x, y) => (x.b ?? 99) - (y.b ?? 99) || (x.a ?? 99) - (y.a ?? 99));
}

/** Pair section headings through the alignment of their text. */
export function matchSections(A: DocModel, B: DocModel, al: Alignment): SectionMatch[] {
  const out: SectionMatch[] = [];
  const usedB = new Set<number>();
  for (const sa of A.sections) {
    const votes = new Map<number, number>();
    al.tokensA.forEach((t, i) => {
      if (t.line !== sa.line || al.aToB[i] < 0) return;
      const lb = B.lines[al.tokensB[al.aToB[i]].line];
      const sb = B.sections.findIndex((s) => s.line === lb.id);
      if (sb >= 0) votes.set(sb, (votes.get(sb) ?? 0) + 1);
    });
    const best = [...votes].sort((x, y) => y[1] - x[1])[0];
    if (best && !usedB.has(best[0])) {
      usedB.add(best[0]);
      out.push({ a: sa.id, b: best[0] });
    } else out.push({ a: sa.id, b: null });
  }
  for (const sb of B.sections) if (!usedB.has(sb.id)) out.push({ a: null, b: sb.id });
  return out;
}
