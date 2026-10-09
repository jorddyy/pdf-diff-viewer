import { useEffect, useRef } from 'preact/hooks';
import type { Change, Segment } from '../align/align';
import type { FigureStatus } from '../align/objects';

export interface Filters {
  text: boolean;
  numeric: boolean;
  equations: boolean;
  moved: boolean;
  figures: boolean;
  renumber: boolean;
  toc: boolean;
}

export const DEFAULT_FILTERS: Filters = { text: true, numeric: true, equations: true, moved: true, figures: true, renumber: false, toc: false };

export function changeCategory(c: Change): keyof Filters {
  if (c.cls === 'toc') return 'toc';
  if (c.kind === 'moved') return 'moved';
  if (c.cls === 'renumber') return 'renumber';
  if (c.cls === 'numeric') return 'numeric';
  if (c.cls === 'equation') return 'equations';
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
  ['equations', 'Equations', 'Edits inside display equations (formula text is noisy; check the page)'],
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
  if (c.cls === 'equation') return ['Equation', 'edit'];
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
  /** Set when a highlight on a page was clicked: show that entry. */
  reveal?: { key: string; n: number } | null;
  /** Filled in by the list: called with the visible part of the new version while the user scrolls the PDFs. */
  follow?: { current: Follower | null };
  onCompare: (matchId: number) => void;
  /** Change which object a figure/table/equation is paired with. */
  onRepair?: (matchId: number) => void;
  note?: string;
}

export function ChangeList({ entries, filters, setFilters, selected, onSelect, reveal, follow, onCompare, onRepair, note }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const counts: Record<keyof Filters, number> = { text: 0, numeric: 0, equations: 0, moved: 0, figures: 0, renumber: 0, toc: 0 };
  for (const e of entries) counts[entryCategory(e)]++;
  const visible = entries.filter((e) => filters[entryCategory(e)]);

  useEffect(() => {
    if (selected === null) return;
    listRef.current?.querySelector(`[data-key="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  useEffect(() => {
    if (reveal) revealEntry(listRef.current, reveal.key);
  }, [reveal]);

  // Scroll along with the PDFs: mark the entries on screen and keep the first
  // change at the current position at the top of the list.
  useEffect(() => {
    if (!follow) return;
    let last = '';
    follow.current = ({ top, bottom }) => {
      const first = followList(listRef.current, visible.map((e) => ({ key: e.key, pos: e.pos })), top, bottom);
      const target = first ?? visible.find((e) => e.pos >= top)?.key ?? null;
      if (target && target !== last) {
        last = target;
        scrollToTop(listRef.current, target);
      }
    };
    return () => {
      follow.current = null;
    };
  }, [follow, visible]);

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
                  {selected === e.key && onRepair && (
                    <div class="snip">
                      <button
                        class="link"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onRepair(+e.key.slice(1));
                        }}
                      >
                        Wrong pair?
                      </button>
                    </div>
                  )}
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
                    {selected === e.key && onRepair && (
                      <button
                        class="link repair"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onRepair(e.fig.matchId);
                        }}
                      >
                        {e.fig.status === 'added' || e.fig.status === 'removed' ? 'Pair with…' : 'Wrong pair?'}
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
                {c.kind === 'moved' && c.move ? (
                  <div class="snip">
                    <span class="moved-text">“{c.move.first} …”</span> ({c.move.words} words) now follows “… {c.move.afterB}”; it used to follow “… {c.move.afterA}”.
                  </div>
                ) : (
                  <>
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
                  </>
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

/** Bring an entry to the middle of its list and flash it (after a click on the page). */
export function revealEntry(list: HTMLElement | null, key: string): void {
  const el = list?.querySelector<HTMLElement>(`[data-key="${key}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('flash');
}

/** Called with the visible range of the new version as positions (page × 10⁴ + y). */
export type Follower = (range: { top: number; bottom: number }) => void;

/** Mark entries whose position is on screen; returns the first of them (list order). */
export function followList(list: HTMLElement | null, items: { key: string; pos: number | null }[], top: number, bottom: number): string | null {
  if (!list) return null;
  const els = new Map<string, HTMLElement>();
  for (const el of list.querySelectorAll<HTMLElement>('[data-key]')) els.set(el.dataset.key!, el);
  let first: string | null = null;
  for (const it of items) {
    const inView = it.pos !== null && it.pos >= top && it.pos <= bottom;
    els.get(it.key)?.classList.toggle('inview', inView);
    if (inView && first === null) first = it.key;
  }
  return first;
}

/** Scroll a list so that an entry (and its section heading) is at the top. */
export function scrollToTop(list: HTMLElement | null, key: string): void {
  const el = list?.querySelector<HTMLElement>(`[data-key="${key}"]`);
  if (!list || !el) return;
  const head = el.previousElementSibling?.classList.contains('sec') ? (el.previousElementSibling as HTMLElement) : el;
  list.scrollTop = head.offsetTop - 4;
}
