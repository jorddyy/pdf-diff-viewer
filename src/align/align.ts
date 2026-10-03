import type { DocModel, Rect } from '../extract/types';
import { unionAll } from '../extract/geometry';
import { digitSkeleton } from '../extract/normalize';
import { diffSeq, type Op } from './diff';
import { intern, tokenize, type Token } from './tokens';

export type ChangeKind = 'insert' | 'delete' | 'replace' | 'moved';
/** text: ordinary edit; numeric: only numbers changed; renumber: only figure/eq/ref numbers; toc: table of contents. */
export type ChangeClass = 'text' | 'numeric' | 'renumber' | 'toc';

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
/** Section-like number: "3", "3.2", "A.3", "12a", optionally bracketed or followed by punctuation. */
const SECTION_NUM = /^[([]?(?:[A-Z]|\d+)(?:\.\d+)*[a-z]?[)\],.;:]*$/;
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

export function alignDocs(A: DocModel, B: DocModel): Alignment {
  const tokensA = tokenize(A);
  const tokensB = tokenize(B);
  const [ia, ib] = intern(tokensA, tokensB);
  const ops = diffSeq(ia, ib);

  const aToB = new Int32Array(tokensA.length).fill(-1);
  const bToA = new Int32Array(tokensB.length).fill(-1);
  const aState = new Uint8Array(tokensA.length).fill(TokState.Changed);
  const bState = new Uint8Array(tokensB.length).fill(TokState.Changed);
  for (const op of ops) {
    if (op.type !== 'equal') continue;
    for (let k = 0; k < op.a1 - op.a0; k++) {
      aToB[op.a0 + k] = op.b0 + k;
      bToA[op.b0 + k] = op.a0 + k;
      aState[op.a0 + k] = TokState.Equal;
      bState[op.b0 + k] = TokState.Equal;
    }
  }

  const moves = detectMoves(ops, ia, ib, tokensA, aToB, bToA, aState, bState);

  const aChange = new Int32Array(tokensA.length).fill(-1);
  const bChange = new Int32Array(tokensB.length).fill(-1);
  const changes: Change[] = [];
  const ctx = { A, B, tokensA, tokensB, aState, bState };

  // Group changed tokens, bridging short equal stretches, in document order.
  let groupA: number[] = [];
  let groupB: number[] = [];
  let bridge = 0;
  let lastA = 0;
  let lastB = 0;
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
  for (const op of ops) {
    if (op.type === 'equal') {
      bridge += op.a1 - op.a0;
      if (bridge > 3) flush();
      lastA = op.a1;
      lastB = op.b1;
      continue;
    }
    for (let t = op.a0; t < op.a1; t++) if (aState[t] === TokState.Changed) groupA.push(t);
    for (let t = op.b0; t < op.b1; t++) if (bState[t] === TokState.Changed) groupB.push(t);
    if (op.a1 > op.a0 || op.b1 > op.b0) bridge = 0;
    lastA = op.a1;
    lastB = op.b1;
  }
  flush();

  for (const mv of moves) {
    const c = buildChange(ctx, changes.length, mv.a, mv.b, mv.a[0], mv.b[0]);
    c.kind = 'moved';
    c.cls = c.cls === 'toc' ? 'toc' : 'text';
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

interface Move {
  a: number[];
  b: number[];
}

/** Long deleted and inserted stretches that share text are reported as moved blocks. */
function detectMoves(
  ops: Op[],
  ia: Int32Array,
  ib: Int32Array,
  tokensA: Token[],
  aToB: Int32Array,
  bToA: Int32Array,
  aState: Uint8Array,
  bState: Uint8Array,
): Move[] {
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
      const inPlace = Math.abs(r.op - d.op) <= 2;
      const sub = diffSeq(ia.subarray(d.a0, d.a1), ib.subarray(r.b0, r.b1));
      const mv: Move = { a: [], b: [] };
      for (const op of sub) {
        if (op.type !== 'equal' || op.a1 - op.a0 < (inPlace ? 3 : 10)) continue;
        // A move needs real prose, not a shared formula like "B0 → D−π+ and Bs0 → Ds−π+".
        if (!inPlace) {
          let words = 0;
          for (let t = d.a0 + op.a0; t < d.a0 + op.a1; t++) if (/^[A-Za-z]{3,}[,.;:]?$/.test(tokensA[t].norm)) words++;
          if (words < 6) continue;
        }
        for (let k = 0; k < op.a1 - op.a0; k++) {
          const ta = d.a0 + op.a0 + k;
          const tb = r.b0 + op.b0 + k;
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
  return {
    id,
    kind,
    cls: classify(ctx, ga, gb),
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
