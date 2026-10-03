import { useEffect, useRef } from 'preact/hooks';
import type { Change, Segment } from '../align/align';
import type { FigureStatus } from '../align/objects';

export interface Filters {
  text: boolean;
  numeric: boolean;
  moved: boolean;
  figures: boolean;
  renumber: boolean;
  toc: boolean;
}

export const DEFAULT_FILTERS: Filters = { text: true, numeric: true, moved: true, figures: true, renumber: false, toc: false };

export function changeCategory(c: Change): keyof Filters {
  if (c.cls === 'toc') return 'toc';
  if (c.kind === 'moved') return 'moved';
  if (c.cls === 'renumber') return 'renumber';
  if (c.cls === 'numeric') return 'numeric';
  return 'text';
}

export function changeVisible(c: Change, f: Filters): boolean {
  return f[changeCategory(c)];
}

export interface FigureInfo {
  matchId: number;
  title: string;
  status: FigureStatus;
  detail: string;
  aPage: number | null;
  bPage: number | null;
}

export type Entry =
  | { key: string; type: 'text'; change: Change; pos: number; section: string }
  | { key: string; type: 'figure'; fig: FigureInfo; pos: number; section: string }
  | { key: string; type: 'renum'; label: string; aPage: number; bPage: number; pos: number; section: string };

export function entryCategory(e: Entry): keyof Filters {
  return e.type === 'text' ? changeCategory(e.change) : e.type === 'figure' ? 'figures' : 'renumber';
}

const FILTER_LABELS: [keyof Filters, string, string][] = [
  ['text', 'Text', 'Edited, added and removed text'],
  ['numeric', 'Numbers', 'Only numbers changed (results, yields, …)'],
  ['moved', 'Moved', 'Text that moved to another place'],
  ['figures', 'Figures', 'Changed, new and removed figures'],
  ['renumber', 'Renumbering', 'Only figure/table/equation/reference numbers changed'],
  ['toc', 'Contents', 'Table of contents'],
];

export function badge(c: Change): [string, string] {
  if (c.kind === 'moved') return ['Moved', 'mv'];
  if (c.cls === 'numeric') return ['Number', 'num'];
  if (c.cls === 'renumber') return ['Renumbered', 'ren'];
  if (c.cls === 'toc') return ['Contents', 'toc'];
  if (c.kind === 'insert') return ['Added', 'ins'];
  if (c.kind === 'delete') return ['Removed', 'del'];
  return ['Edited', 'edit'];
}

export const FIG_BADGE: Record<FigureStatus, [string, string]> = {
  changed: ['Figure changed', 'num'],
  added: ['Figure added', 'ins'],
  removed: ['Figure removed', 'del'],
  pending: ['Comparing…', 'ren'],
  identical: ['Figure', 'ren'],
};

function Segs({ segs, cls }: { segs: Segment[]; cls: string }) {
  return (
    <span>
      {segs.flatMap((s, i) => [i ? ' ' : null, s.changed ? <mark key={i} class={cls}>{s.text}</mark> : <span key={i}>{s.text}</span>])}
    </span>
  );
}

const pageRef = (p: number | null) => (p === null ? '—' : `p.${p + 1}`);

interface Props {
  entries: Entry[];
  filters: Filters;
  setFilters: (f: Filters) => void;
  selected: string | null;
  onSelect: (key: string) => void;
  onCompare: (matchId: number) => void;
  note?: string;
}

export function ChangeList({ entries, filters, setFilters, selected, onSelect, onCompare, note }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const counts: Record<keyof Filters, number> = { text: 0, numeric: 0, moved: 0, figures: 0, renumber: 0, toc: 0 };
  for (const e of entries) counts[entryCategory(e)]++;
  const visible = entries.filter((e) => filters[entryCategory(e)]);

  useEffect(() => {
    if (selected === null) return;
    listRef.current?.querySelector(`[data-key="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  let lastSection = '\u0000';
  return (
    <div class="changes">
      <div class="filters">
        {FILTER_LABELS.map(([key, label, title]) => (
          <button
            key={key}
            class={`chip ${filters[key] ? 'on' : ''}`}
            title={title}
            aria-pressed={filters[key]}
            onClick={() => setFilters({ ...filters, [key]: !filters[key] })}
          >
            {label} <span class="count">{counts[key]}</span>
          </button>
        ))}
      </div>
      {note && <div class="note">{note}</div>}
      <div class="change-list" ref={listRef}>
        {!visible.length && <p class="empty">No changes in the selected categories.</p>}
        {visible.map((e) => {
          const head = e.section !== lastSection ? <div class="sec">{e.section || 'Front matter'}</div> : null;
          lastSection = e.section;
          if (e.type === 'renum') {
            return (
              <>
                {head}
                <div key={e.key} data-key={e.key} class={`chg ${selected === e.key ? 'sel' : ''}`} {...clickable(() => onSelect(e.key))}>
                  <div class="chg-head">
                    <span class="badge ren">Renumbered</span>
                    <span class="lbl">{e.label}</span>
                    <span class="pages">
                      p.{e.aPage + 1} → p.{e.bPage + 1}
                    </span>
                  </div>
                </div>
              </>
            );
          }
          if (e.type === 'figure') {
            const [text, cls] = FIG_BADGE[e.fig.status];
            return (
              <>
                {head}
                <div key={e.key} data-key={e.key} class={`chg fig ${selected === e.key ? 'sel' : ''}`} {...clickable(() => onSelect(e.key))}>
                  <div class="chg-head">
                    <span class={`badge ${cls}`}>{text}</span>
                    <span class="lbl">{e.fig.title}</span>
                    <span class="pages">
                      {pageRef(e.fig.aPage)} → {pageRef(e.fig.bPage)}
                    </span>
                  </div>
                  <div class="snip">
                    {e.fig.detail}{' '}
                    {e.fig.status !== 'pending' && (
                      <button
                        class="link"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onCompare(e.fig.matchId);
                        }}
                      >
                        Compare
                      </button>
                    )}
                  </div>
                </div>
              </>
            );
          }
          const c = e.change;
          const [text, cls] = badge(c);
          return (
            <>
              {head}
              <div key={e.key} data-key={e.key} class={`chg ${selected === e.key ? 'sel' : ''}`} {...clickable(() => onSelect(e.key))}>
                <div class="chg-head">
                  <span class={`badge ${cls}`}>{text}</span>
                  {c.label && <span class="lbl">{c.label}</span>}
                  <span class="pages">
                    p.{c.aPage + 1} → p.{c.bPage + 1}
                  </span>
                </div>
                {c.kind !== 'insert' && (
                  <div class="snip old">
                    <Segs segs={c.aSegs} cls="del" />
                  </div>
                )}
                {c.kind !== 'delete' && (
                  <div class="snip new">
                    <Segs segs={c.bSegs} cls="ins" />
                  </div>
                )}
              </div>
            </>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Props for a card that acts as a button but keeps its text selectable:
 * a click that ends a text selection does not activate it.
 */
export function clickable(activate: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: (e: MouseEvent) => {
      const sel = window.getSelection();
      if (sel && sel.toString().trim() && (e.currentTarget as Node).contains(sel.anchorNode)) return;
      activate();
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      activate();
    },
  };
}
