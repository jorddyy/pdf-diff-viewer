import type { Alignment, Change } from '../align/align';
import type { ObjectMatch, FigureStatus } from '../align/objects';
import type { DocModel, Rect } from '../extract/types';
import type { Token } from '../align/tokens';

export interface Mark {
  box: Rect;
  cls: string;
  /** Entry key: "t<change id>" for text changes, "f<match id>" for figures. */
  key: string;
  title?: string;
  /** Small label drawn on the mark (figure panels). */
  label?: string;
  /** Right edge of the text column (text changes): where the selection bar goes. */
  edge?: number;
}

export type Side = 'a' | 'b';

export function markClass(c: Change, side: Side): string {
  if (c.kind === 'moved') return 'mv';
  if (c.cls === 'numeric') return 'num';
  if (c.cls === 'renumber') return 'ren';
  if (c.cls === 'toc') return 'toc';
  return side === 'a' ? 'del' : 'ins';
}

/** Highlight rectangles per page for one side of an alignment. */
export function sideMarks(doc: DocModel, al: Alignment, side: Side, visible: (c: Change) => boolean): Map<number, Mark[]> {
  const byPage = new Map<number, Mark[]>();
  const add = (page: number, m: Mark) => {
    let list = byPage.get(page);
    if (!list) byPage.set(page, (list = []));
    list.push(m);
  };
  const tokens: Token[] = side === 'a' ? al.tokensA : al.tokensB;
  for (const c of al.changes) {
    if (!visible(c)) continue;
    const cls = markClass(c, side);
    const group = side === 'a' ? c.aTokens : c.bTokens;
    if (!group.length) {
      add(side === 'a' ? c.aPage : c.bPage, { box: side === 'a' ? c.aBox : c.bBox, cls: 'caret ' + cls, key: `t${c.id}`, edge: doc.bodyRight });
      continue;
    }
    // Merge consecutive words on the same line into one rectangle.
    const runs: { page: number; box: Rect }[] = [];
    let cur: { line: number; page: number; box: Rect } | null = null;
    const flush = () => {
      if (cur) runs.push({ page: cur.page, box: lineBand(doc, cur.line, cur.box) });
      cur = null;
    };
    for (const t of group) {
      for (const wid of tokens[t].words) {
        const w = doc.words[wid];
        if (cur && cur.line === w.line && w.box[0] - cur.box[2] < 3 * (w.box[3] - w.box[1])) {
          cur.box = [Math.min(cur.box[0], w.box[0]), Math.min(cur.box[1], w.box[1]), Math.max(cur.box[2], w.box[2]), Math.max(cur.box[3], w.box[3])];
        } else {
          flush();
          cur = { line: w.line, page: w.page, box: [...w.box] as Rect };
        }
      }
    }
    flush();
    for (const r of uniteOverlaps(runs)) add(r.page, { box: r.box, cls, key: `t${c.id}`, edge: doc.bodyRight });
  }
  return byPage;
}

/**
 * Overlapping rectangles of one change become one. The rows of a display formula
 * (numerator, sum, limits, scripts) are separate lines whose tints would otherwise
 * multiply into darker patches.
 */
function uniteOverlaps(runs: { page: number; box: Rect }[]): { page: number; box: Rect }[] {
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < runs.length; i++)
      for (let j = i + 1; j < runs.length; j++) {
        const a = runs[i].box;
        const b = runs[j].box;
        if (runs[i].page !== runs[j].page || a[0] >= b[2] || b[0] >= a[2] || a[1] >= b[3] || b[1] >= a[3]) continue;
        runs[i].box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
        runs.splice(j--, 1);
        merged = true;
      }
  }
  return runs;
}

/**
 * A run's rectangle clipped to the band around its line's baseline. Accents, super-
 * and subscripts (`D*0`, `B0s`) otherwise stretch it into the lines above and below.
 * Display equations keep their full boxes: fractions and limits are separate rows.
 */
function lineBand(doc: DocModel, lineId: number, box: Rect): Rect {
  const l = doc.lines[lineId];
  if (!l || l.kind === 'equation') return box;
  const top = Math.max(box[1], l.base - 0.78 * l.size);
  const bottom = Math.min(box[3], l.base + 0.25 * l.size);
  // A run made only of a script above or below the band keeps its own box.
  return bottom - top < 0.3 * (box[3] - box[1]) ? box : [box[0], top, box[2], bottom];
}

export type PanelState = 'same' | 'changed' | 'new' | 'removed' | 'pending';

/** State of each panel of a figure match on one side, in that side's panel order. */
export function panelStates(m: ObjectMatch, status: FigureStatus, diffs: (number | null)[] | undefined, side: Side, nParts: number, threshold: number): PanelState[] {
  const out: PanelState[] = new Array(nParts).fill(status === 'pending' ? 'pending' : 'same');
  if (status === 'added') return out.fill('new');
  if (status === 'removed') return out.fill('removed');
  m.parts.forEach((p, k) => {
    const idx = side === 'a' ? p.a : p.b;
    if (idx === null || idx >= nParts) return;
    if ((side === 'a' ? p.b : p.a) === null) out[idx] = side === 'a' ? 'removed' : 'new';
    else if (p.sameHash) out[idx] = 'same';
    else if (status === 'pending' || !diffs) out[idx] = 'pending';
    else out[idx] = diffs[k] === null || diffs[k]! > threshold ? 'changed' : 'same';
  });
  return out;
}

const PANEL_LABEL: Record<PanelState, string> = { same: '', changed: 'changed', new: 'new', removed: 'removed', pending: '' };
const PANEL_TITLE: Record<PanelState, string> = {
  same: 'Panel unchanged',
  changed: 'Panel changed: click to compare',
  new: 'New panel',
  removed: 'Panel not in the new version',
  pending: 'Comparing…',
};

/** Outlines for changed, new and removed figures, one per panel with its own state. */
export function addFigureMarks(
  byPage: Map<number, Mark[]>,
  doc: DocModel,
  figs: ObjectMatch[],
  info: (m: ObjectMatch) => { status: FigureStatus; diffs?: (number | null)[] },
  side: Side,
  threshold: number,
): void {
  for (const m of figs) {
    const { status, diffs } = info(m);
    if (status === 'identical') continue;
    const id = side === 'a' ? m.a : m.b;
    if (id === null) continue;
    const o = doc.objects[id];
    const parts = o.parts.length ? o.parts : [o.box];
    const states = panelStates(m, status, diffs, side, parts.length, threshold);
    let list = byPage.get(o.page);
    if (!list) byPage.set(o.page, (list = []));
    const whole = status === 'added' || status === 'removed';
    parts.forEach((box, j) => {
      const st = states[j];
      list!.push({
        box,
        cls: `fig ${st}`,
        key: `f${m.id}`,
        title: whole ? (status === 'added' ? 'New figure' : 'Removed figure') : PANEL_TITLE[st],
        label: whole ? (j === 0 ? (status === 'added' ? 'new figure' : 'removed') : undefined) : parts.length > 1 || st !== 'changed' ? PANEL_LABEL[st] || undefined : undefined,
      });
    });
  }
}
