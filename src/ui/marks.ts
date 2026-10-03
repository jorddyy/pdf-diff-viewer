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
      add(side === 'a' ? c.aPage : c.bPage, { box: side === 'a' ? c.aBox : c.bBox, cls: 'caret ' + cls, key: `t${c.id}` });
      continue;
    }
    // Merge consecutive words on the same line into one rectangle.
    let cur: { line: number; page: number; box: Rect } | null = null;
    const flush = () => {
      if (cur) add(cur.page, { box: cur.box, cls, key: `t${c.id}` });
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
  }
  return byPage;
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
