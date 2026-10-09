import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { Section } from '../extract/types';
import type { SectionMatch } from '../align/objects';
import { entryCategory, type Entry, type Filters, type Follower } from './ChangeList';

interface Row {
  key: string;
  /** Section in the new version, or in the old one when it was removed. */
  sec: Section;
  match: SectionMatch;
  count: number;
  numeric: number;
  pos: number;
}

const posOf = (s: Section) => s.page * 1e4 + s.y;

interface Props {
  sectionsA: Section[];
  sectionsB: Section[];
  matches: SectionMatch[];
  entries: Entry[];
  filters: Filters;
  follow: { current: Follower | null };
  onGo: (match: SectionMatch) => void;
}

/** Outline of the sections: change counts per section, click to show it in both panes. */
export function ContentsPanel({ sectionsA, sectionsB, matches, entries, filters, follow, onGo }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const counts = new Map<string, { n: number; num: number }>();
    for (const e of entries) {
      if (!filters[entryCategory(e)]) continue;
      const c = counts.get(e.section) ?? { n: 0, num: 0 };
      c.n++;
      if (entryCategory(e) === 'numeric') c.num++;
      counts.set(e.section, c);
    }
    const byB = new Map<number, SectionMatch>();
    const byA = new Map<number, SectionMatch>();
    for (const m of matches) {
      if (m.b !== null) byB.set(m.b, m);
      if (m.a !== null) byA.set(m.a, m);
    }
    const out: Row[] = [];
    const label = (s: Section) => `${s.number} ${s.title}`.trim();
    const add = (s: Section, m: SectionMatch, tag: string) => {
      const c = counts.get(label(s));
      out.push({ key: `${tag}${s.id}`, sec: s, match: m, count: c?.n ?? 0, numeric: c?.num ?? 0, pos: posOf(s) });
    };
    // Removed sections go right after the closest earlier old section that still exists.
    const removedAfter = new Map<number, Section[]>();
    let anchorB = -1;
    for (const sa of sectionsA) {
      const m = byA.get(sa.id);
      if (m?.b != null) anchorB = m.b;
      else if (m) removedAfter.set(anchorB, [...(removedAfter.get(anchorB) ?? []), sa]);
    }
    for (const s of removedAfter.get(-1) ?? []) add(s, byA.get(s.id)!, 'a');
    for (const sb of sectionsB) {
      const m = byB.get(sb.id);
      if (m) add(sb, m, 'b');
      for (const s of removedAfter.get(sb.id) ?? []) add(s, byA.get(s.id)!, 'a');
    }
    return out;
  }, [sectionsA, sectionsB, matches, entries, filters]);

  // The section at the top of the new version's pane is highlighted and kept in view.
  useEffect(() => {
    const live = rows.filter((r) => r.match.b !== null);
    let last = '';
    follow.current = ({ top }) => {
      let cur: Row | null = null;
      for (const r of live) if (r.pos <= top + 30) cur = r;
      cur ??= live[0] ?? null;
      const list = listRef.current;
      if (!list || !cur || cur.key === last) return;
      last = cur.key;
      for (const el of list.querySelectorAll<HTMLElement>('[data-key]')) el.classList.toggle('inview', el.dataset.key === cur.key);
      const el = list.querySelector<HTMLElement>(`[data-key="${cur.key}"]`);
      if (el && (el.offsetTop < list.scrollTop || el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight)) list.scrollTop = Math.max(0, el.offsetTop - list.clientHeight / 3);
    };
    return () => {
      follow.current = null;
    };
  }, [follow, rows]);

  if (!rows.length) return <p class="empty">No section headings were found in these documents.</p>;
  const minLevel = Math.min(...rows.map((r) => r.sec.level));
  return (
    <div class="contents" ref={listRef}>
      {rows.map((r) => {
        const tag = r.match.a === null ? 'new' : r.match.b === null ? 'removed' : '';
        return (
          <button
            key={r.key}
            data-key={r.key}
            class={`toc-row${tag ? ' ' + tag : ''}`}
            style={{ paddingLeft: `${10 + (r.sec.level - minLevel) * 14}px` }}
            title={tag === 'new' ? 'New section' : tag === 'removed' ? 'Section removed in the new version' : undefined}
            onClick={() => onGo(r.match)}
          >
            <span class="toc-num">{r.sec.number}</span>
            <span class="toc-title">{r.sec.title}</span>
            {tag && <span class="toc-tag">{tag}</span>}
            {r.count > 0 && <span class={`toc-count${r.numeric ? ' num' : ''}`}>{r.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
