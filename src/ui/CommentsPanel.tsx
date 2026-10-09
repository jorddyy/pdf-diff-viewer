import { Tex } from './Tex';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CommentItem, ParsedComments } from '../comments/parse';
import type { CommentResolution, RefStatus } from '../comments/resolve';
import { clickable, followList, revealEntry, scrollToTop, type Follower } from './ChangeList';

export interface RoundChoice {
  title: string;
  versionId: number | null;
}

export interface VersionOption {
  id: number;
  label: string;
}

/** Status of a comment in each later version (history view). */
export type History = Map<number, { label: string; status: RefStatus | 'general' }[]>;

interface Props {
  /** Set when a comment pin or outline on a page was clicked: show that comment. */
  reveal?: { key: string; n: number } | null;
  /** Filled in by the panel: called with the visible part of the new version while the user scrolls the PDFs. */
  follow?: { current: Follower | null };
  text: string;
  setText: (t: string) => void;
  parsed: ParsedComments | null;
  rounds: RoundChoice[];
  setRoundVersion: (round: number, versionId: number | null) => void;
  versions: VersionOption[];
  resolutions: CommentResolution[];
  targetLabel: string;
  selected: string | null;
  onSelect: (key: string) => void;
  onExport: () => string;
  history: History | null;
  showHistory: boolean;
  setShowHistory: (b: boolean) => void;
  /** Versions comments were written on that are not shown on the left. */
  otherSources: VersionOption[];
  onCompareFrom: (id: number) => void;
  /** Keys of comments ticked off as done. */
  done: Set<string>;
  toggleDone: (key: string) => void;
  onDelete: (item: CommentItem) => void;
  onClearAll: () => void;
}

type Filter = 'all' | 'changed' | 'unchanged' | 'removed' | 'unresolved';

const STATUS_TEXT: Record<RefStatus | 'general', string> = {
  unchanged: 'Unchanged',
  changed: 'Changed',
  moved: 'Moved',
  removed: 'Removed',
  unresolved: 'Not found',
  general: 'General',
};

const STATUS_CLS: Record<RefStatus | 'general', string> = {
  unchanged: 'ren',
  changed: 'num',
  moved: 'mv',
  removed: 'del',
  unresolved: 'toc',
  general: 'toc',
};

export function CommentsPanel(p: Props) {
  const [editing, setEditing] = useState(!p.text);
  const [draft, setDraft] = useState(p.text);
  // Follow outside changes (undo, remove all, restored comparison).
  useEffect(() => setDraft(p.text), [p.text]);
  const [filter, setFilter] = useState<Filter>('all');
  const [showNotes, setShowNotes] = useState(false);
  const [hideDone, setHideDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sourceKey, setSourceKey] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (p.selected) listRef.current?.querySelector(`[data-key="${p.selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [p.selected]);

  useEffect(() => {
    if (p.reveal?.key.startsWith('c')) revealEntry(listRef.current, p.reveal.key);
  }, [p.reveal, editing]);

  // Scroll along with the PDFs: mark comments whose place is on screen and
  // bring the first of them to the top. Comments elsewhere stay put.
  useEffect(() => {
    if (!p.follow) return;
    let last = '';
    const items = p.resolutions.map((r) => {
      const b = r.refs.find((x) => x.target)?.target?.boxes[0];
      return { key: `c${r.item.id}`, pos: b ? b.page * 1e4 + b.box[1] : null };
    });
    p.follow.current = ({ top, bottom }) => {
      const first = followList(listRef.current, items, top, bottom);
      if (first && first !== last) {
        last = first;
        scrollToTop(listRef.current, first);
      }
    };
    return () => {
      if (p.follow) p.follow.current = null;
    };
  }, [p.follow, p.resolutions, editing]);

  if (editing || !p.parsed) {
    return (
      <div class="comments edit">
        <p class="small">
          Paste a review in Markdown (for example from CodiMD/HackMD). Line references like <code>L12</code>, <code>L8-9</code>, figures, tables, equations, sections and quoted text are picked up and
          followed into the newer version.
        </p>
        <textarea value={draft} onInput={(e) => setDraft(e.currentTarget.value)} placeholder={'## Round 1\n\n### Section 2\n- L42: "teh" -> "the"\n- Figure 3: add a legend'} aria-label="Review comments in Markdown" />
        <div class="row">
          <button
            class="btn primary"
            disabled={!draft.trim()}
            onClick={() => {
              p.setText(draft);
              setEditing(false);
            }}
          >
            Use these comments
          </button>
          <button class="btn" onClick={() => fileRef.current?.click()}>
            Load .md file
          </button>
          {p.text && (
            <button
              class="btn"
              onClick={() => {
                setDraft(p.text);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            hidden
            onChange={async (e) => {
              const f = e.currentTarget.files?.[0];
              if (!f) return;
              const t = await f.text();
              setDraft(t);
              p.setText(t);
              setEditing(false);
              e.currentTarget.value = '';
            }}
          />
        </div>
      </div>
    );
  }

  // Comments on versions that are not loaded are only counted, not listed.
  const relevant = p.resolutions.filter((r) => !r.unassigned && (showNotes || !r.item.notes) && !(hideDone && p.done.has(r.item.key)));
  const doneCount = p.resolutions.filter((r) => !r.unassigned && p.done.has(r.item.key)).length;
  const hidden = p.resolutions.filter((r) => r.unassigned && !r.item.notes).length;
  const shown = relevant.filter((r) => filter === 'all' || r.status === filter || (filter === 'changed' && r.status === 'moved') || (filter === 'unresolved' && r.status === 'general'));
  const counts: Record<string, number> = {};
  for (const r of relevant) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const notesCount = p.resolutions.filter((r) => r.item.notes).length;
  let lastHead = '';

  return (
    <div class="comments">
      <div class="rounds">
        {p.rounds.length === 0 && <div class="small">No rounds found: all comments are taken to refer to the left version.</div>}
        {p.rounds.map((r, i) => (
          <label key={i} class="round">
            <span title={r.title}>{r.title}</span>
            <select value={r.versionId ?? ''} onChange={(e) => p.setRoundVersion(i, e.currentTarget.value === '' ? null : +e.currentTarget.value)}>
              <option value="">not loaded</option>
              {p.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {p.otherSources.length > 0 && (
        <div class="note">
          Comments written on {p.otherSources.map((v) => v.label).join(', ')} are shown at their place in {p.targetLabel}.{' '}
          {p.otherSources.flatMap((v, i) => [
            i ? ' · ' : null,
            <button key={v.id} class="link" onClick={() => p.onCompareFrom(v.id)}>
              Compare {v.label} → {p.targetLabel}
            </button>,
          ])}
        </div>
      )}
      <div class="filters">
        {(['all', 'changed', 'unchanged', 'removed', 'unresolved'] as Filter[]).map((f) => (
          <button key={f} class={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'unresolved' ? 'No location' : STATUS_TEXT[f]}{' '}
            <span class="count">{f === 'all' ? shownCount(counts) : f === 'unresolved' ? (counts.unresolved ?? 0) + (counts.general ?? 0) : (counts[f] ?? 0) + (f === 'changed' ? counts.moved ?? 0 : 0)}</span>
          </button>
        ))}
        {notesCount > 0 && (
          <button class={`chip ${showNotes ? 'on' : ''}`} title="Notes to self" onClick={() => setShowNotes(!showNotes)}>
            Notes <span class="count">{notesCount}</span>
          </button>
        )}
        {doneCount > 0 && (
          <button class={`chip ${hideDone ? 'on' : ''}`} title="Hide comments ticked off as done" onClick={() => setHideDone(!hideDone)}>
            Hide done <span class="count">{doneCount}</span>
          </button>
        )}
      </div>
      <div class="row tools">
        <button class="btn" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button
          class="btn"
          title={`Copy the Markdown with locations in ${p.targetLabel} added after each reference`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(p.onExport());
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              download(p.onExport(), `comments-${p.targetLabel}.md`);
            }
          }}
        >
          {copied ? 'Copied ✓' : `Copy annotated for ${p.targetLabel}`}
        </button>
        <button class="btn icon" title="Download annotated Markdown" onClick={() => download(p.onExport(), `comments-${p.targetLabel}.md`)}>
          ⤓
        </button>
        {p.versions.length > 2 && (
          <label class="sync">
            <input type="checkbox" checked={p.showHistory} onChange={(e) => p.setShowHistory(e.currentTarget.checked)} /> History
          </label>
        )}
        <button
          class="btn danger"
          title="Remove all comments from this comparison"
          onClick={() => {
            if (confirm('Remove all comments from this comparison?')) p.onClearAll();
          }}
        >
          Remove all
        </button>
      </div>
      <div class="change-list" ref={listRef}>
        {hidden > 0 && <div class="note">{hidden} comments belong to rounds whose version is not loaded; add that PDF or pick its version above.</div>}
        {!shown.length && <p class="empty">No comments in this category.</p>}
        {shown.map((r) => {
          const it = r.item;
          const head = `${p.parsed!.rounds[it.round] ?? ''}${it.section ? ' · ' + it.section : ''}`;
          const showHead = head !== lastHead;
          lastHead = head;
          const key = `c${it.id}`;
          const hist = p.history?.get(it.id);
          return (
            <>
              {showHead && head && <div class="sec">{head}</div>}
              <div key={key} data-key={key} class={`chg cmt ${p.selected === key ? 'sel' : ''}${p.done.has(it.key) ? ' done' : ''}`} {...clickable(() => p.onSelect(key))}>
                <div class="chg-head">
                  <input
                    type="checkbox"
                    class="done-box"
                    title="Done"
                    aria-label="Done"
                    checked={p.done.has(it.key)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => p.toggleDone(it.key)}
                  />
                  <span class={`badge ${STATUS_CLS[r.status]}`}>{STATUS_TEXT[r.status]}</span>
                  <span class="lbl">
                    {r.refs
                      .filter((x) => x.source || x.target)
                      .map((x) => `${x.source?.label ?? '?'} → ${x.target?.label ?? '—'}`)
                      .join('; ')}
                  </span>
                  <button
                    class="x del"
                    title="Delete this comment (it is removed from the Markdown)"
                    aria-label="Delete comment"
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onDelete(it);
                    }}
                  >
                    ×
                  </button>
                </div>
                {it.quoted && <div class="snip quoted"><Tex text={it.quoted} /></div>}
                <div class="snip new"><Tex text={it.text} /></div>
                {it.reply && (
                  <div class="snip reply">
                    <b>Reply:</b> <Tex text={it.reply} />
                  </div>
                )}
                {p.selected === key && (
                  <button
                    class="link src-toggle"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSourceKey(sourceKey === key ? null : key);
                    }}
                  >
                    {sourceKey === key ? 'Hide source' : 'Show source'}
                  </button>
                )}
                {p.selected === key && sourceKey === key && <pre class="src">{p.text.slice(it.span[0], it.span[1]).trim()}</pre>}
                {r.refs.some((x) => x.note) && <div class="small">{r.refs.map((x) => x.note).filter(Boolean).join('; ')}</div>}
                {p.showHistory && hist && (
                  <div class="hist">
                    {hist.map((h, i) => (
                      <span key={i} class={`badge ${STATUS_CLS[h.status]}`} title={STATUS_TEXT[h.status]}>
                        {h.label}: {STATUS_TEXT[h.status].toLowerCase()}
                      </span>
                    ))}
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

function shownCount(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

function download(text: string, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
