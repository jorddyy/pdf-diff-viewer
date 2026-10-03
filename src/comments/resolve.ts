import type { DocModel, Rect } from '../extract/types';
import { normalizeToken } from '../extract/normalize';
import { TokState, type Alignment } from '../align/align';
import type { ObjectMatch, FigureStatus, SectionMatch } from '../align/objects';
import type { CommentItem, CommentRef } from './parse';

export type RefStatus = 'unchanged' | 'changed' | 'moved' | 'removed' | 'unresolved';

export interface Loc {
  page: number;
  /** Highlight boxes (one per line) on `page` and following pages. */
  boxes: { page: number; box: Rect }[];
  /** Printed line numbers, if the document has them. */
  lines: number[];
  label: string;
}

export interface RefResolution {
  ref: CommentRef;
  source: Loc | null;
  target: Loc | null;
  status: RefStatus;
  note: string;
}

export interface CommentResolution {
  item: CommentItem;
  refs: RefResolution[];
  status: RefStatus | 'general';
  /** The comment's round has no loaded version. */
  unassigned?: boolean;
}

export interface VersionData {
  id: number;
  label: string;
  doc: DocModel;
}

/** What the resolver needs to know about the loaded versions. */
export interface ResolveContext {
  /** Version a round's comments were written on, or null if unknown. */
  versionOfRound(round: number): VersionData | null;
  target: VersionData;
  align(src: VersionData, tgt: VersionData): Alignment;
  objects(src: VersionData, tgt: VersionData): ObjectMatch[];
  sections(src: VersionData, tgt: VersionData): SectionMatch[];
  /** Visual comparison result for a figure match, when known. */
  figureStatus?(src: VersionData, tgt: VersionData, m: ObjectMatch): FigureStatus;
}

const RANK: Record<RefStatus, number> = { removed: 4, changed: 3, moved: 2, unchanged: 1, unresolved: 0 };

export function resolveComment(item: CommentItem, ctx: ResolveContext): CommentResolution {
  const refs: RefResolution[] = [];
  for (const ref of item.refs) {
    if (ref.now) continue;
    const src = ctx.versionOfRound(ref.round);
    if (!src) {
      refs.push({ ref, source: null, target: null, status: 'unresolved', note: 'No version assigned to this round' });
      continue;
    }
    refs.push(resolveRef(ref, item, src, ctx));
  }
  const unassigned = item.round >= 0 && !ctx.versionOfRound(item.round) && refs.every((r) => r.status === 'unresolved');
  if (!refs.length) return { item, refs, status: 'general', unassigned };
  // The comment's status is that of its leading reference ("L242: ... like Fig. 2"),
  // unless that one could not be resolved.
  const lead = refs.find((r) => r.status !== 'unresolved') ?? refs[0];
  return { item, refs, status: lead.status, unassigned };
}

function resolveRef(ref: CommentRef, item: CommentItem, src: VersionData, ctx: ResolveContext): RefResolution {
  const tgt = ctx.target;
  const same = src.id === tgt.id;
  const fail = (note: string): RefResolution => ({ ref, source: null, target: null, status: 'unresolved', note });

  if (ref.kind === 'line') {
    if (!src.doc.hasLineNumbers) return fail(`${src.label} has no line numbers`);
    const al = same ? null : ctx.align(src, tgt);
    const tokens = al ? al.tokensA : null;
    const srcLines = src.doc.lines.filter((l) => l.num !== null && l.num >= ref.from && l.num <= ref.to);
    if (!srcLines.length) return fail(`L${ref.from} not found in ${src.label}`);
    // Tokens of the referenced lines, narrowed to the quoted text when it is found nearby.
    const lineSet = new Set(srcLines.map((l) => l.id));
    const near = new Set(src.doc.lines.filter((l) => l.num !== null && l.num >= ref.from - 3 && l.num <= ref.to + 3).map((l) => l.id));
    const tk = tokens ?? tokenStream(src.doc);
    let anchor: number[] = [];
    // Quoted text on the cited lines; failing that, the closest occurrence nearby.
    for (const snip of item.snippets) {
      const exact = findSnippet(tk, snip, lineSet);
      if (exact.length) anchor.push(...exact);
      else anchor.push(...closest(findSnippet(tk, snip, near), tk, src.doc, ref.from, snip));
    }
    if (!anchor.length) anchor = tk.map((_, i) => i).filter((i) => lineSet.has(tk[i].line));
    if (!anchor.length) return fail(`L${ref.from} has no text in ${src.label}`);
    anchor = [...new Set(anchor)].sort((a, b) => a - b);
    const source = locOf(src.doc, anchor.map((i) => tk[i]));
    if (!al) return { ref, source, target: source, status: 'unchanged', note: '' };
    return mapTokens(ref, al, src, tgt, anchor, source);
  }

  const kind = ref.kind === 'cite' || ref.kind === 'section' ? null : ref.kind;
  if (kind) {
    const out: RefResolution[] = [];
    for (const id of ref.ids) {
      const so = src.doc.objects.find((o) => o.kind === kind && o.number === id);
      if (!so) {
        out.push(fail(`${kindName(kind)} ${id} not found in ${src.label}`));
        continue;
      }
      const source = objLoc(src.doc, so.id, kindName(kind));
      if (same) {
        out.push({ ref, source, target: source, status: 'unchanged', note: '' });
        continue;
      }
      const m = ctx.objects(src, tgt).find((x) => x.a === so.id);
      if (!m || m.b === null) {
        out.push({ ref, source, target: null, status: 'removed', note: `not in ${tgt.label}` });
        continue;
      }
      const target = objLoc(tgt.doc, m.b, kindName(kind));
      let status: RefStatus = m.captionChanged ? 'changed' : 'unchanged';
      if (kind === 'figure') {
        const fs = ctx.figureStatus?.(src, tgt, m) ?? m.status;
        if (fs === 'changed') status = 'changed';
      }
      out.push({ ref, source, target, status, note: m.renumbered ? 'renumbered' : '' });
    }
    return merge(ref, out);
  }

  if (ref.kind === 'section') {
    const id = ref.ids[0];
    const ss = src.doc.sections.find((s) => s.number === id);
    if (!ss) return fail(`Section ${id} not found in ${src.label}`);
    const source = lineLoc(src.doc, [ss.line], `Section ${id}`);
    if (same) return { ref, source, target: source, status: 'unchanged', note: '' };
    const m = ctx.sections(src, tgt).find((x) => x.a === ss.id);
    if (!m || m.b === null) return { ref, source, target: null, status: 'removed', note: `not in ${tgt.label}` };
    const ts = tgt.doc.sections[m.b];
    const al = ctx.align(src, tgt);
    // Any text change between this heading and the next one.
    const end = src.doc.sections.find((s) => s.line > ss.line && s.level <= ss.level)?.line ?? Infinity;
    const changed = al.changes.some((c) => c.aLines.some((l) => l >= ss.line && l < end) && c.cls !== 'renumber' && c.cls !== 'toc');
    return { ref, source, target: lineLoc(tgt.doc, [ts.line], `Section ${ts.number || ts.title}`), status: changed ? 'changed' : 'unchanged', note: ts.number !== id ? 'renumbered' : '' };
  }

  // Citations: find the bibliography entry "[n]" and follow its text.
  const out: RefResolution[] = [];
  const al = same ? null : ctx.align(src, tgt);
  for (const id of ref.ids) {
    const entry = bibEntry(src.doc, id);
    if (!entry.length) {
      out.push(fail(`Reference [${id}] not found in ${src.label}`));
      continue;
    }
    const source = lineLoc(src.doc, entry, `Ref. [${id}]`);
    if (!al) {
      out.push({ ref, source, target: source, status: 'unchanged', note: '' });
      continue;
    }
    const lines = new Set(entry);
    const anchor = al.tokensA.map((_, i) => i).filter((i) => lines.has(al.tokensA[i].line));
    const r = mapTokens(ref, al, src, tgt, anchor, source);
    if (r.target) {
      const first = tgt.doc.lines.find((l) => l.page === r.target!.page && r.target!.boxes.some((b) => b.box[1] <= l.box[1] + 1 && b.box[3] >= l.box[1]));
      const num = first && /^\[(\d+)\]/.exec(tgt.doc.words[first.words[0]]?.norm ?? '');
      if (num) r.target.label = `Ref. [${num[1]}]`;
    }
    out.push(r);
  }
  return merge(ref, out);
}

function merge(ref: CommentRef, rs: RefResolution[]): RefResolution {
  if (rs.length === 1) return rs[0];
  let status: RefStatus = 'unresolved';
  for (const r of rs) if (RANK[r.status] > RANK[status]) status = r.status;
  const src = rs.filter((r) => r.source).map((r) => r.source!);
  const tgt = rs.filter((r) => r.target).map((r) => r.target!);
  const join = (ls: Loc[]): Loc | null =>
    ls.length ? { page: ls[0].page, boxes: ls.flatMap((l) => l.boxes), lines: ls.flatMap((l) => l.lines), label: ls.map((l) => l.label).join(', ') } : null;
  return { ref, source: join(src), target: join(tgt), status, note: rs.map((r) => r.note).filter(Boolean).join('; ') };
}

function kindName(kind: 'figure' | 'table' | 'equation'): string {
  return kind === 'figure' ? 'Figure' : kind === 'table' ? 'Table' : 'Eq.';
}

function mapTokens(ref: CommentRef, al: Alignment, src: VersionData, tgt: VersionData, anchor: number[], source: Loc): RefResolution {
  const mapped: number[] = [];
  const changeIds = new Set<number>();
  let moved = false;
  let same = 0;
  for (const t of anchor) {
    const c = al.aChange[t] >= 0 ? al.changes[al.aChange[t]] : null;
    // Renumbered references ("Fig. 12" → "Fig. 14") do not change the text.
    if (al.aState[t] === TokState.Equal || (c && (c.cls === 'renumber' || c.cls === 'toc'))) same++;
    else if (al.aState[t] === TokState.Moved) moved = true;
    if (al.aToB[t] >= 0) mapped.push(al.aToB[t]);
    if (c) changeIds.add(c.id);
  }
  const lo = anchor[0];
  const hi = anchor[anchor.length - 1];
  // Insertions inside the referenced text count as changes too.
  for (const c of al.changes) if (!c.aTokens.length && c.aAt > lo && c.aAt <= hi) changeIds.add(c.id);
  const changes = [...changeIds].map((id) => al.changes[id]);
  for (const c of changes) mapped.push(...c.bTokens);
  const real = changes.filter((c) => c.cls !== 'renumber' && c.cls !== 'toc' && c.kind !== 'moved');
  let status: RefStatus;
  if (!real.length && same === anchor.length) status = 'unchanged';
  else if (!real.length && moved) status = 'moved';
  else if (!mapped.length) status = 'removed';
  else status = 'changed';
  const uniq = [...new Set(mapped)].sort((a, b) => a - b);
  let target: Loc | null = uniq.length ? locOf(tgt.doc, uniq.map((i) => al.tokensB[i])) : null;
  if (!target) {
    // Removed text: point at where it used to be.
    const c = changes[0];
    if (c) target = { page: c.bPage, boxes: [{ page: c.bPage, box: c.bBox }], lines: [], label: `p.${c.bPage + 1}` };
  }
  void src;
  return { ref, source, target, status, note: status === 'removed' ? `removed in ${tgt.label}` : moved ? 'moved' : '' };
}

interface TokLike {
  norm: string;
  words: number[];
  line: number;
}

/** Plain token stream when no alignment is needed (source and target are the same version). */
function tokenStream(doc: DocModel): TokLike[] {
  const out: TokLike[] = [];
  for (const l of doc.lines) for (const w of l.words) out.push({ norm: doc.words[w].norm, words: [w], line: l.id });
  return out;
}

const fold = (s: string) => normalizeToken(s).toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** Token indices of a quoted snippet within the given lines (all occurrences). */
function findSnippet(tokens: TokLike[], snippet: string, lines: Set<number>): number[] {
  const want = snippet.split(/\s+/).map(fold).filter(Boolean);
  if (!want.length) return [];
  const out: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!lines.has(tokens[i].line)) continue;
    let ok = true;
    for (let k = 0; k < want.length; k++) {
      const t = tokens[i + k];
      if (!t || fold(t.norm) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) for (let k = 0; k < want.length; k++) out.push(i + k);
  }
  return out;
}

/** Of several matches of a snippet, keep the one nearest to the cited line. */
function closest(found: number[], tk: TokLike[], doc: DocModel, line: number, snip: string): number[] {
  const n = snip.split(/\s+/).filter(Boolean).length;
  let best: number[] = [];
  let bestD = Infinity;
  for (let i = 0; i < found.length; i += n) {
    const d = Math.abs((doc.lines[tk[found[i]].line].num ?? 1e9) - line);
    if (d < bestD) {
      bestD = d;
      best = found.slice(i, i + n);
    }
  }
  return best;
}

function locOf(doc: DocModel, toks: TokLike[]): Loc {
  const byLine = new Map<number, Rect>();
  for (const t of toks) {
    for (const wid of t.words) {
      const w = doc.words[wid];
      const b = byLine.get(w.line);
      byLine.set(w.line, b ? [Math.min(b[0], w.box[0]), Math.min(b[1], w.box[1]), Math.max(b[2], w.box[2]), Math.max(b[3], w.box[3])] : ([...w.box] as Rect));
    }
  }
  const lineIds = [...byLine.keys()].sort((a, b) => a - b);
  const boxes = lineIds.map((id) => ({ page: doc.lines[id].page, box: byLine.get(id)! }));
  const nums = lineIds.map((id) => doc.lines[id].num).filter((n): n is number => n !== null);
  const page = boxes[0]?.page ?? 0;
  return { page, boxes, lines: nums, label: lineLabel(nums, page) };
}

function lineLoc(doc: DocModel, lineIds: number[], label: string): Loc {
  const boxes = lineIds.map((id) => ({ page: doc.lines[id].page, box: doc.lines[id].box }));
  const nums = lineIds.map((id) => doc.lines[id].num).filter((n): n is number => n !== null);
  return { page: boxes[0]?.page ?? 0, boxes, lines: nums, label };
}

function objLoc(doc: DocModel, id: number, kind: string): Loc {
  const o = doc.objects[id];
  return { page: o.page, boxes: [{ page: o.page, box: o.box }], lines: [], label: `${kind} ${o.number}`.trim() };
}

function lineLabel(nums: number[], page: number): string {
  if (!nums.length) return `p.${page + 1}`;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return lo === hi ? `L${lo}` : `L${lo}–${hi}`;
}

/** Lines of bibliography entry [id]: from the line starting with "[id]" to the next entry. */
function bibEntry(doc: DocModel, id: string): number[] {
  const startIdx = doc.lines.findIndex((l, i) => i > doc.lines.length / 3 && doc.words[l.words[0]]?.norm === `[${id}]`);
  if (startIdx < 0) return [];
  const out = [doc.lines[startIdx].id];
  for (let i = startIdx + 1; i < doc.lines.length && out.length < 8; i++) {
    const l = doc.lines[i];
    if (/^\[\d+\]$/.test(doc.words[l.words[0]]?.norm ?? '') || l.kind === 'heading' || l.kind === 'footer') break;
    out.push(l.id);
  }
  return out;
}
