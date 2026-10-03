import { useEffect, useRef, useState } from 'preact/hooks';
import type { ParsedComments } from '../comments/parse';
import type { CommentResolution, RefStatus } from '../comments/resolve';

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
  const [filter, setFilter] = useState<Filter>('all');
  const [showNotes, setShowNotes] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (p.selected) listRef.current?.querySelector(`[data-key="${p.selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [p.selected]);

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
  const relevant = p.resolutions.filter((r) => !r.unassigned && (showNotes || !r.item.notes));
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
              <button key={key} data-key={key} class={`chg cmt ${p.selected === key ? 'sel' : ''}`} onClick={() => p.onSelect(key)}>
                <div class="chg-head">
                  <span class={`badge ${STATUS_CLS[r.status]}`}>{STATUS_TEXT[r.status]}</span>
                  <span class="lbl">
                    {r.refs
                      .filter((x) => x.source || x.target)
                      .map((x) => `${x.source?.label ?? '?'} → ${x.target?.label ?? '—'}`)
                      .join('; ')}
                  </span>
                </div>
                {it.quoted && <div class="snip quoted">{it.quoted}</div>}
                <div class="snip new">{it.text}</div>
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
              </button>
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
