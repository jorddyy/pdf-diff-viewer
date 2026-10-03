import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { extractInBrowser, openForCompare, openForDisplay, sha256, type PageSize } from './pdf/load';
import { clearCache, getCached, putCached } from './pdf/cache';
import { alignDocs, type Alignment } from './align/align';
import type { DocModel } from './extract/types';
import { PaneControl, PdfPane } from './ui/PdfPane';
import { ChangeList, DEFAULT_FILTERS, changeVisible, entryCategory, type Entry, type Filters } from './ui/ChangeList';
import { CompareModal, type CompareRequest } from './ui/CompareModal';
import { matchObjects, type FigureStatus, type ObjectMatch } from './align/objects';
import { CHANGED_THRESHOLD, inkDiff, renderRegions, type Raster } from './figures/compare';
import { addFigureMarks, sideMarks, type Side } from './ui/marks';
import { buildAnchors, mapPos } from './ui/sync';
import { parseComments } from './comments/parse';
import { assignRounds } from './comments/assign';
import { resolveComment, type CommentResolution, type ResolveContext, type VersionData } from './comments/resolve';
import { annotateMarkdown } from './comments/export';
import { matchSections, type SectionMatch } from './align/objects';
import { CommentsPanel, type History } from './ui/CommentsPanel';
import type { Mark } from './ui/marks';

export interface Version {
  id: number;
  name: string;
  bytes: ArrayBuffer;
  pdf: PDFDocumentProxy | null;
  sizes: PageSize[];
  doc: DocModel | null;
  progress: number;
  error: string | null;
  label: string;
}

let nextId = 1;

function labelFromName(name: string): string {
  const m = /(?:^|[^a-z])v(\d+(?:[._]\d+)*)/i.exec(name);
  return m ? `v${m[1].replace('_', '.')}` : name.replace(/\.pdf$/i, '');
}

function versionKey(label: string): number[] {
  const m = /(\d+(?:\.\d+)*)/.exec(label);
  return m ? m[1].split('.').map(Number) : [Infinity];
}

function sortVersions(vs: Version[]): Version[] {
  return [...vs].sort((x, y) => {
    const a = versionKey(x.label);
    const b = versionKey(y.label);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d) return d;
    }
    return x.id - y.id;
  });
}

export function App() {
  const [versions, setVersions] = useState<Version[]>([]);
  const [left, setLeft] = useState<number | null>(null);
  const [right, setRight] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<CompareRequest | null>(null);
  const [zoom, setZoom] = useState<number | null>(null); // null: fit page width
  const [fitScale, setFitScale] = useState(1);
  const panesRef = useRef<HTMLElement>(null);
  const [sync, setSync] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState<'changes' | 'comments'>('changes');
  const [commentText, setCommentText] = useState(() => storageGet('pdfdiff.comments') ?? '');
  const [roundOverride, setRoundOverride] = useState<Map<number, number | null>>(new Map());
  const [showHistory, setShowHistory] = useState(false);
  const alignCache = useRef(new Map<string, Alignment>());
  const objCache = useRef(new Map<string, ObjectMatch[]>());
  const secCache = useRef(new Map<string, SectionMatch[]>());
  const ctlA = useMemo(() => new PaneControl(), []);
  const ctlB = useMemo(() => new PaneControl(), []);
  const fileInput = useRef<HTMLInputElement>(null);

  // Fit the widest page into a pane until the user zooms.
  useEffect(() => {
    const el = panesRef.current;
    if (!el) return;
    const measure = () => {
      const cols = [...el.querySelectorAll<HTMLElement>('.pane')];
      if (!cols.length) return;
      const width = Math.min(...cols.map((c) => c.clientWidth));
      const pageW = Math.max(1, ...versions.flatMap((v) => v.sizes.map((s) => s.width)));
      setFitScale(Math.max(0.3, Math.min(3, (width - 2 * 14 - 18) / pageW)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [versions.map((v) => `${v.id}:${v.sizes.length}`).join(), left, right]);
  const scale = zoom ?? fitScale;

  const update = useCallback((id: number, patch: Partial<Version>) => {
    setVersions((vs) => sortVersions(vs.map((v) => (v.id === id ? { ...v, ...patch } : v))));
  }, []);

  const getAlign = useCallback((a: { id: number; doc: DocModel }, b: { id: number; doc: DocModel }) => {
    const key = `${a.id}:${b.id}`;
    let r = alignCache.current.get(key);
    if (!r) {
      r = alignDocs(a.doc, b.doc);
      alignCache.current.set(key, r);
    }
    return r;
  }, []);

  const addFiles = useCallback(
    async (files: Iterable<File>) => {
      for (const f of files) {
        if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') continue;
        const bytes = await f.arrayBuffer();
        const id = nextId++;
        const v: Version = { id, name: f.name, bytes, pdf: null, sizes: [], doc: null, progress: 0, error: null, label: labelFromName(f.name) };
        setVersions((vs) => sortVersions([...vs, v]));
        openForDisplay(bytes)
          .then(({ pdf, sizes }) => update(id, { pdf, sizes }))
          .catch((e) => update(id, { error: String(e?.message ?? e) }));
        (async () => {
          const hash = await sha256(bytes);
          let doc = await getCached(hash);
          if (doc) doc.name = f.name;
          else {
            doc = await extractInBrowser(bytes, f.name, (d, t) => update(id, { progress: d / t }));
            putCached(hash, doc);
          }
          update(id, { doc, label: doc.label, progress: 1 });
        })().catch((e) => update(id, { error: String(e?.message ?? e) }));
      }
    },
    [update],
  );

  // Default pair: the two newest versions, until the user picks a pair.
  const [pairChosen, setPairChosen] = useState(false);
  useEffect(() => {
    const ids = versions.map((v) => v.id);
    if (pairChosen && left !== null && ids.includes(left) && right !== null && ids.includes(right)) return;
    if (versions.length >= 2) {
      setLeft(versions[versions.length - 2].id);
      setRight(versions[versions.length - 1].id);
    } else if (versions.length === 1) {
      setLeft(versions[0].id);
      setRight(null);
    }
  }, [versions, left, right, pairChosen]);

  const A = versions.find((v) => v.id === left) ?? null;
  const B = versions.find((v) => v.id === right) ?? null;

  const al = useMemo(() => (A?.doc && B?.doc ? getAlign({ id: A.id, doc: A.doc }, { id: B.id, doc: B.doc }) : null), [A?.doc, B?.doc]);

  const objectsFor = useCallback(
    (a: VersionData, b: VersionData) => {
      const key = `${a.id}:${b.id}`;
      let r = objCache.current.get(key);
      if (!r) {
        r = matchObjects(a.doc, b.doc, getAlign(a, b));
        objCache.current.set(key, r);
      }
      return r;
    },
    [getAlign],
  );
  const sectionsFor = useCallback(
    (a: VersionData, b: VersionData) => {
      const key = `${a.id}:${b.id}`;
      let r = secCache.current.get(key);
      if (!r) {
        r = matchSections(a.doc, b.doc, getAlign(a, b));
        secCache.current.set(key, r);
      }
      return r;
    },
    [getAlign],
  );
  const figs = useMemo(
    () => (al && A?.doc && B?.doc ? objectsFor({ id: A.id, label: A.label, doc: A.doc }, { id: B.id, label: B.label, doc: B.doc }).filter((m) => m.kind === 'figure') : []),
    [al],
  );
  const [figStatus, setFigStatus] = useState<Map<number, { status: FigureStatus; diffs: (number | null)[] }>>(new Map());
  useEffect(() => {
    setSelected(null);
    setFigStatus(new Map());
  }, [al]);

  // Compare figures whose graphics are not byte-identical, in the background.
  // Separate pdf.js workers keep page rendering in the panes responsive.
  useEffect(() => {
    if (!A?.doc || !B?.doc) return;
    if (!figs.some((m) => m.status === 'pending')) return;
    let cancelled = false;
    const [da, db] = [A.doc, B.doc];
    let pa: PDFDocumentProxy | null = null;
    let pb: PDFDocumentProxy | null = null;
    (async () => {
      [pa, pb] = await Promise.all([openForCompare(A.bytes), openForCompare(B.bytes)]);
      for (const m of figs) {
        if (cancelled) return;
        if (m.status !== 'pending' || m.a === null || m.b === null) continue;
        const oa = da.objects[m.a];
        const ob = db.objects[m.b];
        const todo = m.parts.filter((p) => !p.sameHash && p.a !== null && p.b !== null);
        let ra: Raster[] = [];
        let rb: Raster[] = [];
        try {
          if (todo.length) {
            ra = await renderRegions(pa!, oa.page, todo.map((p) => oa.parts[p.a!]), 240);
            rb = await renderRegions(pb!, ob.page, todo.map((p) => ob.parts[p.b!]), 240);
          }
        } catch {
          ra = [];
          rb = [];
        }
        if (cancelled) return;
        const diffs = m.parts.map((p) => {
          if (p.sameHash) return 0;
          const k = todo.indexOf(p);
          return k >= 0 && ra[k] && rb[k] ? inkDiff(ra[k], rb[k]) : null;
        });
        const changed = diffs.some((d) => d === null || d > CHANGED_THRESHOLD) || !m.parts.length;
        setFigStatus((prev) => new Map(prev).set(m.id, { status: changed ? 'changed' : 'identical', diffs }));
      }
    })().finally(() => {
      pa?.loadingTask.destroy();
      pb?.loadingTask.destroy();
    });
    return () => {
      cancelled = true;
    };
  }, [figs, A?.doc, B?.doc]);

  const statusOf = useCallback((m: ObjectMatch): FigureStatus => figStatus.get(m.id)?.status ?? m.status, [figStatus]);
  const anchors = useMemo(() => (al && A?.doc && B?.doc ? buildAnchors(A.doc, B.doc, al) : null), [al]);

  const entries = useMemo<Entry[]>(() => {
    if (!al || !A?.doc || !B?.doc) return [];
    const da = A.doc;
    const db = B.doc;
    const secName = (doc: DocModel, line: number) => {
      const s = line >= 0 ? doc.sections[doc.lines[line].section] : undefined;
      return s ? `${s.number} ${s.title}`.trim() : '';
    };
    const out: Entry[] = al.changes.map((c) => ({ key: `t${c.id}`, type: 'text' as const, change: c, pos: c.bPage * 1e4 + c.bBox[1], section: c.section }));
    for (const m of figs) {
      const status = statusOf(m);
      if (status === 'identical') continue;
      const oa = m.a !== null ? da.objects[m.a] : null;
      const ob = m.b !== null ? db.objects[m.b] : null;
      const name = (o: typeof oa) => (o ? (o.number ? `Figure ${o.number}` : 'Unnumbered figure') : '');
      const title = oa && ob && oa.number !== ob.number ? `${name(oa)} → ${name(ob)}` : name(ob ?? oa);
      const st = figStatus.get(m.id);
      let detail = '';
      if (status === 'changed' && st) {
        const n = st.diffs.filter((d) => d === null || d > CHANGED_THRESHOLD).length;
        detail = m.parts.length > 1 ? `${n} of ${m.parts.length} panels differ.` : 'The graphic differs.';
      } else if (status === 'pending') detail = 'Comparing the graphics…';
      else if (status === 'added') detail = 'New in this version.';
      else if (status === 'removed') detail = 'Not in the new version.';
      let pos: number;
      if (ob) pos = ob.page * 1e4 + ob.box[1];
      else {
        const mp = anchors && mapPos(anchors, 'a', { page: oa!.page, y: oa!.box[1] });
        pos = mp ? mp.page * 1e4 + mp.y : 0;
      }
      out.push({
        key: `f${m.id}`,
        type: 'figure',
        fig: { matchId: m.id, title, status, detail, aPage: oa?.page ?? null, bPage: ob?.page ?? null },
        pos,
        section: ob ? secName(db, ob.lines[0] ?? -1) : oa ? secName(da, oa.lines[0] ?? -1) : '',
      });
    }
    return out.sort((x, y) => x.pos - y.pos);
  }, [al, figs, statusOf, figStatus, anchors]);

  // ---- Review comments ----
  useEffect(() => storageSet('pdfdiff.comments', commentText), [commentText]);
  const parsed = useMemo(() => (commentText.trim() ? parseComments(commentText) : null), [commentText]);
  const ready = versions.filter((v) => v.doc);
  const readyKey = ready.map((v) => v.id).join(',');
  const autoRounds = useMemo(
    () => (parsed && ready.length === versions.length && ready.length ? assignRounds(parsed, ready.map((v) => ({ id: v.id, doc: v.doc! }))) : []),
    [parsed, readyKey, versions.length],
  );
  const roundVersion = (r: number): number | null => (roundOverride.has(r) ? roundOverride.get(r)! : (autoRounds[r] ?? null));
  const vdata = (v: Version | null | undefined): VersionData | null => (v?.doc ? { id: v.id, label: v.label, doc: v.doc } : null);

  const makeCtx = useCallback(
    (target: VersionData): ResolveContext => ({
      versionOfRound: (r) => (r < 0 ? vdata(A) : vdata(versions.find((v) => v.id === roundVersion(r)))),
      target,
      align: getAlign,
      objects: objectsFor,
      sections: sectionsFor,
      figureStatus: (src, tgt, m) => (src.id === A?.id && tgt.id === B?.id ? (figStatus.get(m.id)?.status ?? m.status) : m.status),
    }),
    [A, B, versions, roundOverride, autoRounds, figStatus, getAlign, objectsFor, sectionsFor],
  );

  const resolutions = useMemo<CommentResolution[]>(() => {
    const target = vdata(B);
    if (!parsed || !target) return [];
    const ctx = makeCtx(target);
    return parsed.items.map((it) => resolveComment(it, ctx));
  }, [parsed, makeCtx, B?.doc]);

  const history = useMemo<History | null>(() => {
    if (!showHistory || !parsed) return null;
    const out: History = new Map();
    const ready = versions.filter((v) => v.doc);
    for (const it of parsed.items) {
      const src = it.round < 0 ? A : versions.find((v) => v.id === roundVersion(it.round));
      if (!src) continue;
      const later = ready.slice(ready.findIndex((v) => v.id === src.id) + 1);
      out.set(
        it.id,
        later.map((v) => ({ label: v.label, status: resolveComment(it, makeCtx(vdata(v)!)).status })),
      );
    }
    return out;
  }, [showHistory, parsed, makeCtx]);

  const commentMarks = useMemo(() => {
    const a = new Map<number, Mark[]>();
    const b = new Map<number, Mark[]>();
    if (tab !== 'comments' || !A || !B) return { a, b };
    const push = (m: Map<number, Mark[]>, page: number, mk: Mark) => {
      if (!m.has(page)) m.set(page, []);
      m.get(page)!.push(mk);
    };
    for (const r of resolutions) {
      const key = `c${r.item.id}`;
      const sel = selected === key;
      for (const ref of r.refs) {
        const srcV = ref.ref.round < 0 ? A.id : roundVersion(ref.ref.round);
        const title = r.item.text.slice(0, 200);
        // Pins in the margin for every comment; outlines for the selected one.
        if (ref.target) {
          const first = ref.target.boxes[0];
          if (first) push(b, first.page, { box: [6, first.box[1], 14, first.box[3]], cls: 'cpin', key, title });
          if (sel) for (const x of ref.target.boxes) push(b, x.page, { box: x.box, cls: `cmt ${r.status}`, key, title });
        }
        if (ref.source && srcV === A.id) {
          const first = ref.source.boxes[0];
          if (first) push(a, first.page, { box: [6, first.box[1], 14, first.box[3]], cls: 'cpin', key, title });
          if (sel) for (const x of ref.source.boxes) push(a, x.page, { box: x.box, cls: 'cmt src', key, title });
        }
      }
    }
    return { a, b };
  }, [resolutions, selected, tab, A?.id, B?.id]);

  const exportComments = useCallback(() => (B ? annotateMarkdown(commentText, resolutions, B.label) : commentText), [commentText, resolutions, B?.label]);

  const visibleChange = useCallback((c: Alignment['changes'][number]) => changeVisible(c, filters), [filters]);
  const figVisible = filters.figures;
  const marksA = useMemo(() => {
    if (!al || !A?.doc) return new Map();
    const m = sideMarks(A.doc, al, 'a', visibleChange);
    if (figVisible) addFigureMarks(m, A.doc, figs, statusOf, 'a');
    return m;
  }, [al, A?.doc, visibleChange, figs, statusOf, figVisible]);
  const marksB = useMemo(() => {
    if (!al || !B?.doc) return new Map();
    const m = sideMarks(B.doc, al, 'b', visibleChange);
    if (figVisible) addFigureMarks(m, B.doc, figs, statusOf, 'b');
    return m;
  }, [al, B?.doc, visibleChange, figs, statusOf, figVisible]);

  const openCompare = useCallback(
    (matchId: number) => {
      const m = figs.find((x) => x.id === matchId);
      if (!m || !A?.pdf || !B?.pdf || !A.doc || !B.doc) return;
      const oa = m.a !== null ? A.doc.objects[m.a] : null;
      const ob = m.b !== null ? B.doc.objects[m.b] : null;
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      const parts = m.parts.length ? m.parts : [{ a: oa ? 0 : null, b: ob ? 0 : null, sameHash: false }];
      setCompare({
        title: (oa && ob && oa.number !== ob.number ? `Figure ${oa.number} → ${ob.number}` : `Figure ${(ob ?? oa)?.number ?? ''}`).trim(),
        aLabel: A.label,
        bLabel: B.label,
        pairs: parts.map((p, i) => ({
          label: parts.length > 1 ? `Panel (${letters[i] ?? i + 1})` : 'Figure',
          a: oa && p.a !== null ? { pdf: A.pdf!, page: oa.page, rect: oa.parts[p.a] ?? oa.box } : null,
          b: ob && p.b !== null ? { pdf: B.pdf!, page: ob.page, rect: ob.parts[p.b] ?? ob.box } : null,
        })),
      });
    },
    [figs, A, B],
  );

  const select = useCallback(
    (key: string) => {
      if (!al || !A?.doc || !B?.doc) return;
      setSelected(key);
      if (key.startsWith('c')) {
        const r = resolutions.find((x) => x.item.id === +key.slice(1));
        const ref = r?.refs.find((x) => x.target || x.source);
        if (!ref) return;
        const tb = ref.target?.boxes[0];
        const sb = ref.source?.boxes[0];
        if (ref.target) ctlB.scrollTo({ page: tb?.page ?? ref.target.page, y: tb?.box[1] ?? 0 }, true, tb ? [tb.box[0], tb.box[2]] : undefined);
        if (ref.source && (ref.ref.round < 0 ? A.id : roundVersion(ref.ref.round)) === A.id)
          ctlA.scrollTo({ page: sb?.page ?? ref.source.page, y: sb?.box[1] ?? 0 }, true, sb ? [sb.box[0], sb.box[2]] : undefined);
        return;
      }
      if (key.startsWith('t')) {
        const c = al.changes[+key.slice(1)];
        ctlA.scrollTo({ page: c.aPage, y: (c.aBox[1] + c.aBox[3]) / 2 }, true, [c.aBox[0], c.aBox[2]]);
        ctlB.scrollTo({ page: c.bPage, y: (c.bBox[1] + c.bBox[3]) / 2 }, true, [c.bBox[0], c.bBox[2]]);
        return;
      }
      const m = figs.find((x) => x.id === +key.slice(1));
      if (!m) return;
      const oa = m.a !== null ? A.doc.objects[m.a] : null;
      const ob = m.b !== null ? B.doc.objects[m.b] : null;
      if (oa) ctlA.scrollTo({ page: oa.page, y: (oa.box[1] + oa.box[3]) / 2 }, true);
      if (ob) ctlB.scrollTo({ page: ob.page, y: (ob.box[1] + ob.box[3]) / 2 }, true);
      const other = oa && !ob ? anchors && mapPos(anchors, 'a', { page: oa.page, y: oa.box[1] }) : !oa && ob ? anchors && mapPos(anchors, 'b', { page: ob.page, y: ob.box[1] }) : null;
      if (other) (oa ? ctlB : ctlA).scrollTo(other, true);
    },
    [al, figs, anchors, A?.doc, B?.doc, ctlA, ctlB, resolutions, roundOverride, autoRounds],
  );

  const onMarkClick = useCallback(
    (key: string) => {
      select(key);
      if (key.startsWith('f')) openCompare(+key.slice(1));
    },
    [select, openCompare],
  );

  const onScroll = (side: Side) => {
    if (!sync || !anchors) return;
    const [from, to] = side === 'a' ? [ctlA, ctlB] : [ctlB, ctlA];
    if (from.isQuiet()) return;
    const pos = from.centerPos();
    const target = pos && mapPos(anchors, side, pos);
    if (target) to.scrollTo(target);
  };

  // Keyboard: j/n next change, k/p previous.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!al || compare || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      const list = entries.filter((x) => filters[entryCategory(x)]);
      if (!list.length) return;
      const idx = selected === null ? -1 : list.findIndex((x) => x.key === selected);
      if (e.key === 'j' || e.key === 'n') select(list[Math.min(list.length - 1, idx + 1)].key);
      else if (e.key === 'k' || e.key === 'p') select(list[Math.max(0, idx - 1)].key);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [al, entries, filters, selected, select, compare]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer?.files) addFiles([...e.dataTransfer.files]);
  };

  return (
    <div
      class="app"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!(e.relatedTarget as Node | null) || !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header class="top">
        <h1>PDF diff</h1>
        <div class="versions">
          {versions.map((v) => (
            <span key={v.id} class={`vchip ${v.error ? 'err' : ''}`} title={v.error ?? v.name}>
              {v.label}
              {!v.doc && !v.error && <span class="prog" style={{ width: `${Math.round(v.progress * 100)}%` }} />}
              <button
                class="x"
                title={`Remove ${v.name}`}
                onClick={() => {
                  v.pdf?.loadingTask.destroy();
                  for (const k of [...alignCache.current.keys()]) if (k.split(':').includes(String(v.id))) alignCache.current.delete(k);
                  setVersions((vs) => vs.filter((x) => x.id !== v.id));
                }}
              >
                ×
              </button>
            </span>
          ))}
          <button class="btn" onClick={() => fileInput.current?.click()}>
            + Add PDFs
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            onChange={(e) => {
              const input = e.currentTarget;
              if (input.files) addFiles([...input.files]);
              input.value = '';
            }}
          />
        </div>
        {versions.length >= 2 && (
          <div class="pair">
            <select
              value={left ?? ''}
              onChange={(e) => {
                setPairChosen(true);
                setLeft(+e.currentTarget.value);
              }}
              aria-label="Old version"
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
            <button
              class="btn icon"
              title="Swap"
              onClick={() => {
                setPairChosen(true);
                setLeft(right);
                setRight(left);
              }}
            >
              ⇄
            </button>
            <select
              value={right ?? ''}
              onChange={(e) => {
                setPairChosen(true);
                setRight(+e.currentTarget.value);
              }}
              aria-label="New version"
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div class="view">
          <label class="sync">
            <input type="checkbox" checked={sync} onChange={(e) => setSync(e.currentTarget.checked)} /> Sync scroll
          </label>
          <button class={`btn ${zoom === null ? 'on' : ''}`} title="Fit page width" onClick={() => setZoom(null)}>
            Fit
          </button>
          <button class="btn icon" title="Zoom out" onClick={() => setZoom(Math.max(0.3, +(scale / 1.15).toFixed(2)))}>
            −
          </button>
          <span class="zoom">{Math.round(scale * 100)}%</span>
          <button class="btn icon" title="Zoom in" onClick={() => setZoom(Math.min(4, +(scale * 1.15).toFixed(2)))}>
            +
          </button>
        </div>
      </header>

      {versions.length === 0 ? (
        <main class="welcome">
          <div class="drop">
            <h2>Compare versions of an analysis note or paper draft</h2>
            <p>Drop two or more PDF versions here, or</p>
            <button class="btn primary" onClick={() => fileInput.current?.click()}>
              Choose PDFs
            </button>
            <ul class="how">
              <li>Text is compared word by word, ignoring line numbers, page numbers and reflowed lines.</li>
              <li>Figures are matched across versions (also when renumbered) and compared visually.</li>
              <li>Paste your review comments (Markdown) to see where <code>L123</code>, <code>Figure 4</code> and friends ended up in the new version.</li>
            </ul>
            <p class="small">
              Everything runs in this browser tab: the PDFs and comments are never uploaded. Analysed versions are cached in this browser only.{' '}
              <button
                class="link"
                onClick={async () => {
                  await clearCache();
                  storageSet('pdfdiff.comments', '');
                  setCommentText('');
                }}
              >
                Clear stored data
              </button>
            </p>
            <p class="small">Keys: j/n next change, k/p previous; in the figure comparison 1–4 switch views, Esc closes.</p>
          </div>
        </main>
      ) : (
        <main class="work">
          <aside class="side">
            <div class="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'changes'} class={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
                Changes
              </button>
              <button role="tab" aria-selected={tab === 'comments'} class={tab === 'comments' ? 'on' : ''} onClick={() => setTab('comments')}>
                Comments{parsed ? ` (${parsed.items.filter((i) => !i.notes).length})` : ''}
              </button>
            </div>
            {tab === 'comments' ? (
              <CommentsPanel
                text={commentText}
                setText={(t) => {
                  setCommentText(t);
                  setRoundOverride(new Map());
                }}
                parsed={parsed}
                rounds={(parsed?.rounds ?? []).map((title, i) => ({ title, versionId: roundVersion(i) }))}
                setRoundVersion={(r, v) => setRoundOverride((m) => new Map(m).set(r, v))}
                versions={versions.map((v) => ({ id: v.id, label: v.label }))}
                resolutions={resolutions}
                targetLabel={B?.label ?? ''}
                selected={selected}
                onSelect={select}
                onExport={exportComments}
                history={history}
                showHistory={showHistory}
                setShowHistory={setShowHistory}
                otherSources={[...new Set((parsed?.rounds ?? []).map((_, i) => roundVersion(i)))]
                  .filter((id): id is number => id !== null && id !== A?.id && id !== B?.id)
                  .filter((id) => versions.findIndex((v) => v.id === id) < versions.findIndex((v) => v.id === B?.id))
                  .map((id) => ({ id, label: versions.find((v) => v.id === id)?.label ?? '' }))}
                onCompareFrom={(id) => {
                  setPairChosen(true);
                  setLeft(id);
                }}
              />
            ) : A && B ? (
              al ? (
                <ChangeList
                  entries={entries}
                  filters={filters}
                  setFilters={setFilters}
                  selected={selected}
                  onSelect={select}
                  onCompare={openCompare}
                  note={figs.some((m) => statusOf(m) === 'pending') ? 'Comparing figures in the background…' : undefined}
                />
              ) : (
                <Progress versions={[A, B]} />
              )
            ) : (
              <p class="empty">Add another version to compare.</p>
            )}
          </aside>
          <section class="panes" ref={panesRef}>
            {[A, B].map((v, i) =>
              v ? (
                <div class="col" key={v.id}>
                  <div class="col-head">
                    <strong>{v.label}</strong> <span class="fname">{v.name}</span>
                    {v.doc && <span class="meta">{v.doc.numPages} pages{v.doc.hasLineNumbers ? ' · line numbers' : ''}</span>}
                    {v.doc && !v.doc.quality.ok && (
                      <span class="warn" title="Many glyphs have no usable text mapping (e.g. a browser re-print); the text diff may be unreliable.">
                        broken text layer
                      </span>
                    )}
                  </div>
                  {v.pdf ? (
                    <PdfPane
                      pdf={v.pdf}
                      pages={v.sizes}
                      scale={scale}
                      marks={mergeMarks(i === 0 ? marksA : marksB, i === 0 ? commentMarks.a : commentMarks.b)}
                      selected={selected}
                      control={i === 0 ? ctlA : ctlB}
                      onMarkClick={onMarkClick}
                      onScroll={() => onScroll(i === 0 ? 'a' : 'b')}
                    />
                  ) : (
                    <div class="pane loading">{v.error ?? 'Opening…'}</div>
                  )}
                </div>
              ) : null,
            )}
          </section>
        </main>
      )}
      {dragging && <div class="dropmask">Drop PDFs to add them</div>}
      {compare && <CompareModal req={compare} onClose={() => setCompare(null)} />}
    </div>
  );
}

function Progress({ versions }: { versions: Version[] }) {
  return (
    <div class="progress">
      {versions.map((v) => (
        <div key={v.id}>
          <div>
            {v.error ? `${v.label}: ${v.error}` : v.doc ? `${v.label}: analysed` : `Analysing ${v.label}… ${Math.round(v.progress * 100)}%`}
          </div>
          <div class="bar">
            <span style={{ width: `${Math.round((v.doc ? 1 : v.progress) * 100)}%` }} />
          </div>
        </div>
      ))}
      <p class="small">Reading text, line numbers and figures. Large notes take a few seconds.</p>
    </div>
  );
}

function mergeMarks(a: Map<number, Mark[]>, b: Map<number, Mark[]>): Map<number, Mark[]> {
  if (!b.size) return a;
  const out = new Map(a);
  for (const [p, list] of b) out.set(p, [...(out.get(p) ?? []), ...list]);
  return out;
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Storage unavailable: the comments just are not remembered.
  }
}
