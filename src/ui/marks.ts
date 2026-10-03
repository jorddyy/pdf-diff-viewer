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

const FIG_TITLES: Record<FigureStatus, string> = {
  changed: 'Figure changed: click to compare',
  added: 'New figure',
  removed: 'Removed figure',
  pending: 'Comparing figure…',
  identical: 'Figure unchanged',
};

/** Outlines for changed, new and removed figures. */
export function addFigureMarks(byPage: Map<number, Mark[]>, doc: DocModel, figs: ObjectMatch[], status: (m: ObjectMatch) => FigureStatus, side: Side): void {
  for (const m of figs) {
    const st = status(m);
    if (st === 'identical') continue;
    const id = side === 'a' ? m.a : m.b;
    if (id === null) continue;
    const o = doc.objects[id];
    const parts = o.parts.length ? o.parts : [o.box];
    for (const box of parts) {
      let list = byPage.get(o.page);
      if (!list) byPage.set(o.page, (list = []));
      list.push({ box, cls: `fig ${st}`, key: `f${m.id}`, title: FIG_TITLES[st] });
    }
  }
}
