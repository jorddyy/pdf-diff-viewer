import type { DocModel, Rect } from '../extract/types';
import { unionAll } from '../extract/geometry';
import { digitSkeleton } from '../extract/normalize';
import { diffSeq, type Op } from './diff';
import { intern, tokenize, type Token } from './tokens';

export type ChangeKind = 'insert' | 'delete' | 'replace' | 'moved';
/** text: ordinary edit; numeric: only numbers changed; renumber: only figure/eq/ref numbers; toc: table of contents. */
export type ChangeClass = 'text' | 'numeric' | 'renumber' | 'toc' | 'equation';

export interface Segment {
  text: string;
  changed: boolean;
}

export interface Change {
  id: number;
  kind: ChangeKind;
  cls: ChangeClass;
  aTokens: number[];
  bTokens: number[];
  /** First changed token, or the insertion point when nothing changed on that side. */
  aAt: number;
  bAt: number;
  aPage: number;
  bPage: number;
  /** Changed words on the first page, or a caret where text was inserted/removed. */
  aBox: Rect;
  bBox: Rect;
  aLines: number[];
  bLines: number[];
  section: string;
  label: string;
  aSegs: Segment[];
  bSegs: Segment[];
  /** For moved blocks: size, opening words and what precedes the block in each version. */
  move?: { words: number; first: string; afterA: string; afterB: string };
}

export const enum TokState {
  Equal = 0,
  Changed = 1,
  Moved = 2,
}

export interface Alignment {
  aLabel: string;
  bLabel: string;
  tokensA: Token[];
  tokensB: Token[];
  /** Counterpart token (equal or moved text), or -1. */
  aToB: Int32Array;
  bToA: Int32Array;
  aState: Uint8Array;
  bState: Uint8Array;
  /** Change id per token, or -1. */
  aChange: Int32Array;
  bChange: Int32Array;
  changes: Change[];
}

const REF_WORD = /^(fig(ure)?s?|tab(le)?s?|eqs?|equations?|sec(tion)?s?|refs?|app(endix)?|appendices|chapters?|lines?|l)\.?$/i;
/**
 * Reference-like number: "3", "3.2", "A.3", "12a", or a range "17-19" (dashes
 * are normalised), optionally bracketed or followed by punctuation.
 */
const SECTION_NUM = /^[([]?(?:[A-Z]|\d+)(?:\.\d+)*[a-z]?(?:-(?:[A-Z]\.?)?\d+(?:\.\d+)*[a-z]?)?[)\],.;:]*$/;
/** Whole number (no decimals), optionally "A." prefixed, bracketed or followed by punctuation. */
const INT_TOKEN = /^[[(]?(?:[A-Z]\.)?\d+[a-z]?[\])]?[,.;:]?$/;
/** Citation numbers: "[23]", "[7," and "8]" in "[7, 8]". */
const CITATION = /^(\[\d+[\],;]?[,.;:]?|\d+\][,.;:]?)$/;
/** Equation numbers: "(13)", "(A.3)". */
const EQ_NUMBER = /^\((?:[A-Z]\.)?\d+[a-z]?\)[,.;:]?$/;

export type PairClass = 'same' | 'renumber' | 'numeric' | 'text';

/**
 * How a changed token pair differs. `prev` holds the preceding tokens of the
 * old text, nearest first. Only whole numbers in reference positions are
 * renumbering ("Fig. 12", "[23]", "(13)", a heading's number); every other
 * change of digits, such as "(1.23 ± 0.04)" → "(1.31 ± 0.05)", is a number change.
 */
export function classifyPair(x: string, y: string, prev: string[], headingFirst: boolean): PairClass {
  if (x === y) return 'same';
  if (!/\d/.test(x) || !/\d/.test(y) || digitSkeleton(x) !== digitSkeleton(y)) return 'text';
  const [p1 = '', p2 = '', p3 = ''] = prev;
  if ((headingFirst || REF_WORD.test(p1)) && SECTION_NUM.test(x) && SECTION_NUM.test(y)) return 'renumber';
  if (!INT_TOKEN.test(x) || !INT_TOKEN.test(y)) return 'numeric';
  if (CITATION.test(x) && CITATION.test(y)) return 'renumber';
  if (EQ_NUMBER.test(x) && EQ_NUMBER.test(y)) return 'renumber';
  // Lists after a reference word: "Figs. 12 and 13", "Tables 7, 8".
  if (/^(and|&|-|–|to|,)$/.test(p1) && INT_TOKEN.test(p2) && REF_WORD.test(p3)) return 'renumber';
  if (/^\d+,$/.test(p1) && REF_WORD.test(p2)) return 'renumber';
  return 'numeric';
}

/**
 * Captions and table contents are floats: LaTeX may place them elsewhere in
 * a new version without anything changing. They are aligned float by float
 * (paired by content), never as part of the running text, so they cannot be
 * reported as moved.
 */
function isFloatLine(doc: DocModel, lineId: number): boolean {
  const l = doc.lines[lineId];
  if (l.kind !== 'caption' && l.kind !== 'table') return false;
  const o = l.object >= 0 ? doc.objects[l.object] : null;
  return !!o && o.kind !== 'equation';
}

interface Segment2 {
  a: number[];
  b: number[];
  sa: Int32Array;
  sb: Int32Array;
  ops: Op[];
}

export function alignDocs(A: DocModel, B: DocModel): Alignment {
  const tokensA = tokenize(A);
  const tokensB = tokenize(B);
  const [ia, ib] = intern(tokensA, tokensB);
  const aToB = new Int32Array(tokensA.length).fill(-1);
  const bToA = new Int32Array(tokensB.length).fill(-1);
  const aState = new Uint8Array(tokensA.length).fill(TokState.Changed);
  const bState = new Uint8Array(tokensB.length).fill(TokState.Changed);

  // Split into the running text and one stream per float.
  const split = (doc: DocModel, tokens: Token[]) => {
    const body: number[] = [];
    const floats = new Map<number, number[]>();
    tokens.forEach((t, i) => {
      if (!isFloatLine(doc, t.line)) body.push(i);
      else {
        const o = doc.lines[t.line].object;
        if (!floats.has(o)) floats.set(o, []);
        floats.get(o)!.push(i);
      }
    });
    return { body, floats };
  };
  const sA = split(A, tokensA);
  const sB = split(B, tokensB);

  const run = (a: number[], b: number[]): Segment2 => {
    const sa = Int32Array.from(a, (i) => ia[i]);
    const sb = Int32Array.from(b, (i) => ib[i]);
    const ops = diffSeq(sa, sb);
    for (const op of ops) {
      if (op.type !== 'equal') continue;
      for (let k = 0; k < op.a1 - op.a0; k++) {
        const ta = a[op.a0 + k];
        const tb = b[op.b0 + k];
        aToB[ta] = tb;
        bToA[tb] = ta;
        aState[ta] = TokState.Equal;
        bState[tb] = TokState.Equal;
      }
    }
    return { a, b, sa, sb, ops };
  };

  const body = run(sA.body, sB.body);
  const moves = mergeMoves(detectMoves(body, tokensA, aToB, bToA, aState, bState));
  // Inside a moved block, leftover pieces that also occur in its new place belong to the move.
  const runLen = (map: Int32Array, t: number) => {
    let n = 1;
    for (let k = 1; t - k >= 0 && map[t - k] >= 0 && map[t - k] === map[t] - k; k++) n++;
    for (let k = 1; t + k < map.length && map[t + k] >= 0 && map[t + k] === map[t] + k; k++) n++;
    return n;
  };
  for (const mv of moves) {
    const lastA = mv.a[mv.a.length - 1];
    const lastB = mv.b[mv.b.length - 1];
    // Common words inside the block that the plain diff paired with text
    // outside it (one or two in a row) are coincidences: try them here first.
    const freed: [number, number][] = [];
    for (const t of sA.body) {
      if (t < mv.a[0] || t > lastA || aState[t] !== TokState.Equal) continue;
      if ((aToB[t] < mv.b[0] || aToB[t] > lastB) && runLen(aToB, t) <= 2) freed.push([t, aToB[t]]);
    }
    for (const t of sB.body) {
      if (t < mv.b[0] || t > lastB || bState[t] !== TokState.Equal) continue;
      if ((bToA[t] < mv.a[0] || bToA[t] > lastA) && runLen(bToA, t) <= 2) freed.push([bToA[t], t]);
    }
    for (const [ta, tb] of freed) {
      aToB[ta] = -1;
      bToA[tb] = -1;
      aState[ta] = TokState.Changed;
      bState[tb] = TokState.Changed;
    }
    const inA = sA.body.filter((t) => t >= mv.a[0] && t <= lastA && aState[t] !== TokState.Equal);
    const inB = sB.body.filter((t) => t >= mv.b[0] && t <= lastB && bState[t] !== TokState.Equal);
    for (const op of diffSeq(Int32Array.from(inA, (t) => ia[t]), Int32Array.from(inB, (t) => ib[t]))) {
      if (op.type !== 'equal') continue;
      for (let k = 0; k < op.a1 - op.a0; k++) {
        const ta = inA[op.a0 + k];
        const tb = inB[op.b0 + k];
        if (aState[ta] !== TokState.Changed || bState[tb] !== TokState.Changed) continue;
        aToB[ta] = tb;
        bToA[tb] = ta;
        aState[ta] = TokState.Moved;
        bState[tb] = TokState.Moved;
        mv.a.push(ta);
        mv.b.push(tb);
      }
    }
    // Restore the freed pairs that found no better partner.
    for (const [ta, tb] of freed) {
      if (aState[ta] !== TokState.Changed || bState[tb] !== TokState.Changed) continue;
      aToB[ta] = tb;
      bToA[tb] = ta;
      aState[ta] = TokState.Equal;
      bState[tb] = TokState.Equal;
    }
    mv.a.sort((x, y) => x - y);
    mv.b.sort((x, y) => x - y);
  }
  const segs: Segment2[] = [body];
  const pairedA = new Set<number>();
  const pairedB = new Set<number>();
  for (const [x, y] of pairFloats(A, B, tokensA, tokensB, sA.floats, sB.floats)) {
    segs.push(run(sA.floats.get(x)!, sB.floats.get(y)!));
    pairedA.add(x);
    pairedB.add(y);
  }
  for (const [x, t] of sA.floats) if (!pairedA.has(x)) segs.push(run(t, []));
  for (const [y, t] of sB.floats) if (!pairedB.has(y)) segs.push(run([], t));

  // Where a float without partner would sit in the other version: after the
  // counterpart of the closest preceding mapped token.
  const placeInB = (ta: number) => {
    for (let t = ta - 1; t >= 0; t--) if (aToB[t] >= 0) return aToB[t] + 1;
    return 0;
  };
  const placeInA = (tb: number) => {
    for (let t = tb - 1; t >= 0; t--) if (bToA[t] >= 0) return bToA[t] + 1;
    return 0;
  };

  const aChange = new Int32Array(tokensA.length).fill(-1);
  const bChange = new Int32Array(tokensB.length).fill(-1);
  const changes: Change[] = [];
  const ctx = { A, B, tokensA, tokensB, aState, bState };

  // Group changed tokens of each stream, bridging short equal stretches.
  for (const seg of segs) {
    const gA = (k: number) => (k < seg.a.length ? seg.a[k] : seg.a.length ? seg.a[seg.a.length - 1] + 1 : placeInA(seg.b[0] ?? 0));
    const gB = (k: number) => (k < seg.b.length ? seg.b[k] : seg.b.length ? seg.b[seg.b.length - 1] + 1 : placeInB(seg.a[0] ?? 0));
    let groupA: number[] = [];
    let groupB: number[] = [];
    let bridge = 0;
    let lastA = gA(0);
    let lastB = gB(0);
    const flush = () => {
      if (groupA.length || groupB.length) {
        const c = buildChange(ctx, changes.length, groupA, groupB, lastA, lastB);
        for (const t of groupA) aChange[t] = c.id;
        for (const t of groupB) bChange[t] = c.id;
        changes.push(c);
      }
      groupA = [];
      groupB = [];
      bridge = 0;
    };
    for (const op of seg.ops) {
      if (op.type === 'equal') {
        bridge += op.a1 - op.a0;
        if (bridge > 3) flush();
        lastA = gA(op.a1);
        lastB = gB(op.b1);
        continue;
      }
      for (let k = op.a0; k < op.a1; k++) if (aState[seg.a[k]] === TokState.Changed) groupA.push(seg.a[k]);
      for (let k = op.b0; k < op.b1; k++) if (bState[seg.b[k]] === TokState.Changed) groupB.push(seg.b[k]);
      if (op.a1 > op.a0 || op.b1 > op.b0) bridge = 0;
      lastA = gA(op.a1);
      lastB = gB(op.b1);
    }
    flush();
  }

  const text = (doc: DocModel, tokens: Token[], from: number, to: number) =>
    tokens
      .slice(Math.max(0, from), Math.max(0, to))
      .map((t) => t.words.map((w) => doc.words[w].text).join(''))
      .join(' ');
  for (const mv of moves) {
    const c = buildChange(ctx, changes.length, mv.a, mv.b, mv.a[0], mv.b[0]);
    c.kind = 'moved';
    c.cls = c.cls === 'toc' ? 'toc' : 'text';
    c.move = {
      words: mv.a.length,
      first: text(A, tokensA, mv.a[0], mv.a[0] + 10),
      afterA: text(A, tokensA, mv.a[0] - 6, mv.a[0]),
      afterB: text(B, tokensB, mv.b[0] - 6, mv.b[0]),
    };
    for (const t of mv.a) aChange[t] = c.id;
    for (const t of mv.b) bChange[t] = c.id;
    changes.push(c);
  }
  changes.sort((x, y) => x.bAt - y.bAt || x.aAt - y.aAt);
  // Re-number in display order and fix the token → change maps.
  const remap = new Map<number, number>();
  changes.forEach((c, i) => {
    remap.set(c.id, i);
    c.id = i;
  });
  for (let t = 0; t < aChange.length; t++) if (aChange[t] >= 0) aChange[t] = remap.get(aChange[t])!;
  for (let t = 0; t < bChange.length; t++) if (bChange[t] >= 0) bChange[t] = remap.get(bChange[t])!;

  return { aLabel: A.label, bLabel: B.label, tokensA, tokensB, aToB, bToA, aState, bState, aChange, bChange, changes };
}

/**
 * Pair the floats of two versions by content (shared words, identical
 * figure graphics), preferring the same relative position and number.
 */
function pairFloats(A: DocModel, B: DocModel, tokensA: Token[], tokensB: Token[], fa: Map<number, number[]>, fb: Map<number, number[]>): [number, number][] {
  const bag = (tokens: Token[], idx: number[]) => {
    const m = new Map<string, number>();
    for (const i of idx) {
      // Punctuation after a word must not make "m(D0K+)," differ from "m(D0K+).".
      const n = tokens[i].norm.toLowerCase().replace(/^[(\[]+|[.,;:)\]]+$/g, '');
      m.set(n, (m.get(n) ?? 0) + 1);
    }
    return m;
  };
  const listA = [...fa].map(([o, idx], k) => ({ o, bag: bag(tokensA, idx), n: idx.length, rel: k / Math.max(1, fa.size - 1) }));
  const listB = [...fb].map(([o, idx], k) => ({ o, bag: bag(tokensB, idx), n: idx.length, rel: k / Math.max(1, fb.size - 1) }));
  const cands: { a: number; b: number; score: number }[] = [];
  for (const x of listA) {
    const oa = A.objects[x.o];
    for (const y of listB) {
      const ob = B.objects[y.o];
      if (oa.kind !== ob.kind) continue;
      let inter = 0;
      for (const [k, c] of x.bag) inter += Math.min(c, y.bag.get(k) ?? 0);
      let score = (2 * inter) / (x.n + y.n);
      if (oa.kind === 'figure' && oa.hashes.some((h) => h && ob.hashes.includes(h))) score += 0.3;
      if (oa.number === ob.number) score += 0.02;
      score -= 0.05 * Math.abs(x.rel - y.rel);
      cands.push({ a: x.o, b: y.o, score });
    }
  }
  cands.sort((x, y) => y.score - x.score);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const out: [number, number][] = [];
  for (const c of cands) {
    if (c.score < 0.4 || usedA.has(c.a) || usedB.has(c.b)) continue;
    usedA.add(c.a);
    usedB.add(c.b);
    out.push([c.a, c.b]);
  }
  return out;
}

interface Move {
  a: number[];
  b: number[];
}

/** Pieces of one moved block (split by small edits) become one move. */
function mergeMoves(moves: Move[]): Move[] {
  const out: Move[] = [];
  for (const m of moves.filter((x) => x.a.length).sort((x, y) => x.a[0] - y.a[0])) {
    const last = out[out.length - 1];
    const gapA = last ? m.a[0] - last.a[last.a.length - 1] : Infinity;
    const gapB = last ? m.b[0] - last.b[last.b.length - 1] : Infinity;
    if (last && gapA <= 80 && gapB >= 0 && gapB <= 80) {
      last.a.push(...m.a);
      last.b.push(...m.b);
    } else out.push({ a: [...m.a], b: [...m.b] });
  }
  return out;
}

/** Long deleted and inserted stretches of the running text that share text are reported as moved blocks. */
function detectMoves(seg: Segment2, tokensA: Token[], aToB: Int32Array, bToA: Int32Array, aState: Uint8Array, bState: Uint8Array): Move[] {
  const { ops, sa: ia, sb: ib } = seg;
  const K = 5;
  const delRuns: { a0: number; a1: number; op: number }[] = [];
  const insRuns: { b0: number; b1: number; op: number }[] = [];
  ops.forEach((op, k) => {
    if (op.type === 'delete' && op.a1 - op.a0 >= 8) delRuns.push({ a0: op.a0, a1: op.a1, op: k });
    if (op.type === 'insert' && op.b1 - op.b0 >= 8) insRuns.push({ b0: op.b0, b1: op.b1, op: k });
  });
  if (!delRuns.length || !insRuns.length) return [];
  const key = (s: Int32Array, i: number) => `${s[i]},${s[i + 1]},${s[i + 2]},${s[i + 3]},${s[i + 4]}`;
  const index = new Map<string, number[]>();
  insRuns.forEach((r, ri) => {
    for (let j = r.b0; j + K <= r.b1; j++) {
      const h = key(ib, j);
      const list = index.get(h);
      if (list) {
        if (list[list.length - 1] !== ri) list.push(ri);
      } else index.set(h, [ri]);
    }
  });

  const moves: Move[] = [];
  for (const d of delRuns) {
    const hits = new Map<number, number>();
    for (let i = d.a0; i + K <= d.a1; i++) for (const ri of index.get(key(ia, i)) ?? []) hits.set(ri, (hits.get(ri) ?? 0) + 1);
    for (const [ri, n] of [...hits].sort((x, y) => y[1] - x[1])) {
      if (n < 3) break;
      const r = insRuns[ri];
      // Adjacent paragraphs swapped produce delete/equal/insert. Crossing a
      // substantial unchanged passage is a move, even with only three ops.
      const crossed = ops.slice(Math.min(r.op, d.op) + 1, Math.max(r.op, d.op));
      const crossesProse = crossed.some((op) => op.type === 'equal' && op.a1 - op.a0 >= 10 &&
        seg.a.slice(op.a0, op.a1).filter((t) => /^[A-Za-z]{3,}[,.;:]?$/.test(tokensA[t].norm)).length >= 6);
      const inPlace = Math.abs(r.op - d.op) <= 2 && !crossesProse;
      const sub = diffSeq(ia.subarray(d.a0, d.a1), ib.subarray(r.b0, r.b1));
      const mv: Move = { a: [], b: [] };
      for (const op of sub) {
        if (op.type !== 'equal' || op.a1 - op.a0 < (inPlace ? 3 : 10)) continue;
        // A move needs real prose, not a shared formula like "B0 → D−π+ and Bs0 → Ds−π+".
        if (!inPlace) {
          let words = 0;
          for (let k = d.a0 + op.a0; k < d.a0 + op.a1; k++) if (/^[A-Za-z]{3,}[,.;:]?$/.test(tokensA[seg.a[k]].norm)) words++;
          if (words < 6) continue;
        }
        for (let k = 0; k < op.a1 - op.a0; k++) {
          const ta = seg.a[d.a0 + op.a0 + k];
          const tb = seg.b[r.b0 + op.b0 + k];
          if (aState[ta] !== TokState.Changed || bState[tb] !== TokState.Changed) continue;
          aToB[ta] = tb;
          bToA[tb] = ta;
          aState[ta] = inPlace ? TokState.Equal : TokState.Moved;
          bState[tb] = inPlace ? TokState.Equal : TokState.Moved;
          if (!inPlace) {
            mv.a.push(ta);
            mv.b.push(tb);
          }
        }
      }
      if (mv.a.length) moves.push(mv);
    }
  }
  return moves;
}

interface Ctx {
  A: DocModel;
  B: DocModel;
  tokensA: Token[];
  tokensB: Token[];
  aState: Uint8Array;
  bState: Uint8Array;
}

function buildChange(ctx: Ctx, id: number, ga: number[], gb: number[], atA: number, atB: number): Change {
  const { A, B, tokensA, tokensB } = ctx;
  const kind: ChangeKind = ga.length && gb.length ? 'replace' : ga.length ? 'delete' : 'insert';
  const [aPage, aBox, aLines] = locate(A, tokensA, ga, atA);
  const [bPage, bBox, bLines] = locate(B, tokensB, gb, atB);
  const firstLine = ga.length ? A.lines[tokensA[ga[0]].line] : gb.length ? B.lines[tokensB[gb[0]].line] : null;
  const doc = ga.length ? A : B;
  const sec = firstLine && firstLine.section >= 0 ? doc.sections[firstLine.section] : null;
  const obj = firstLine && firstLine.object >= 0 ? doc.objects[firstLine.object] : null;
  const label = obj
    ? obj.kind === 'figure'
      ? `Figure ${obj.number} caption`
      : obj.kind === 'table'
        ? `Table ${obj.number}`
        : `Eq. (${obj.number})`
    : firstLine?.kind === 'heading'
      ? 'Heading'
      : '';
  // Maths token order is noisy: edits inside a display equation get their own class.
  // Pure number changes stay "numeric" (results are often written as equations).
  const inEquation = [firstLine, gb.length ? B.lines[tokensB[gb[0]].line] : null].some((l) => l && l.object >= 0 && (l === firstLine ? doc : B).objects[l.object].kind === 'equation');
  let cls = classify(ctx, ga, gb);
  if (cls === 'text' && inEquation) cls = 'equation';
  return {
    id,
    kind,
    cls,
    aTokens: ga,
    bTokens: gb,
    aAt: ga.length ? ga[0] : atA,
    bAt: gb.length ? gb[0] : atB,
    aPage,
    bPage,
    aBox,
    bBox,
    aLines,
    bLines,
    section: sec ? `${sec.number} ${sec.title}`.trim() : '',
    label,
    aSegs: segments(A, tokensA, ctx.aState, ga, atA),
    bSegs: segments(B, tokensB, ctx.bState, gb, atB),
  };
}

function locate(doc: DocModel, tokens: Token[], group: number[], at: number): [number, Rect, number[]] {
  if (group.length) {
    const words = group.flatMap((t) => tokens[t].words).map((w) => doc.words[w]);
    const page = words[0].page;
    const box = unionAll(words.filter((w) => w.page === page).map((w) => w.box))!;
    const lines = [...new Set(group.map((t) => tokens[t].line))];
    return [page, box, lines];
  }
  // Insertion point: a caret after the preceding token (or before the next one).
  const prev = tokens[Math.min(at, tokens.length) - 1];
  const next = tokens[at];
  const ref = prev ?? next;
  if (!ref) return [0, [0, 0, 0, 0], []];
  const w = doc.words[prev ? ref.words[ref.words.length - 1] : ref.words[0]];
  const x = prev ? w.box[2] + 1 : w.box[0] - 1;
  return [w.page, [x - 1, w.box[1], x + 1, w.box[3]], []];
}

/** Text of the change with a little context, for the change list. */
function segments(doc: DocModel, tokens: Token[], state: Uint8Array, group: number[], at: number): Segment[] {
  const from = group.length ? group[0] : at;
  const to = group.length ? group[group.length - 1] + 1 : at;
  const segs: Segment[] = [];
  const add = (text: string, changed: boolean) => {
    const last = segs[segs.length - 1];
    if (last && last.changed === changed) last.text += ' ' + text;
    else segs.push({ text, changed });
  };
  const inGroup = new Set(group);
  const ctxN = 4;
  for (let t = Math.max(0, from - ctxN); t < Math.min(tokens.length, to + ctxN); t++) {
    const text = tokens[t].words.map((w) => doc.words[w].text).join('');
    add(text, inGroup.has(t) && state[t] !== TokState.Equal);
  }
  return segs;
}

function classify(ctx: Ctx, ga: number[], gb: number[]): ChangeClass {
  const { A, B, tokensA, tokensB } = ctx;
  const lineKinds = [...ga.map((t) => A.lines[tokensA[t].line].kind), ...gb.map((t) => B.lines[tokensB[t].line].kind)];
  if (lineKinds.length && lineKinds.every((k) => k === 'toc')) return 'toc';
  if (ga.length !== gb.length || !ga.length) return 'text';
  let renumber = true;
  for (let k = 0; k < ga.length; k++) {
    const t = ga[k];
    const prev = [1, 2, 3].map((d) => (t - d >= 0 ? tokensA[t - d].norm : ''));
    const line = A.lines[tokensA[t].line];
    const headingFirst = line.kind === 'heading' && line.words[0] === tokensA[t].words[0];
    const c = classifyPair(tokensA[t].norm, tokensB[gb[k]].norm, prev, headingFirst);
    if (c === 'text') return 'text';
    if (c === 'numeric') renumber = false;
  }
  return renumber ? 'renumber' : 'numeric';
}
