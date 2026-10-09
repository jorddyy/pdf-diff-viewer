import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { extractInBrowser, openForCompare, openForDisplay, sha256, type PageSize } from './pdf/load';
import { clearCache, getCached, putCached } from './pdf/cache';
import { alignDocs, type Alignment } from './align/align';
import type { DocModel } from './extract/types';
import { PANE_PAD, PageBox, PaneControl, PdfPane, type InputKind } from './ui/PdfPane';
import { ChangeList, DEFAULT_FILTERS, FIG_BADGE, badge, changeVisible, entryCategory, type Entry, type Filters, type Follower } from './ui/ChangeList';
import { ExportDialog, type ExportOptions } from './ui/ExportDialog';
import { buildSideBySide } from './export/sideBySide';
import { buildAnnotated, textChangeSpecs, type AnnotationSpec } from './export/annotated';
import type { SummaryItem } from './export/types';
import { CompareModal, type CompareRequest } from './ui/CompareModal';
import { matchObjects, type FigureStatus, type ObjectMatch } from './align/objects';
import { CHANGED_THRESHOLD, inkDiff, renderRegions, type Raster } from './figures/compare';
import { addFigureMarks, panelStates, sideMarks, type PanelState, type Side } from './ui/marks';
import { buildSyncMap, mapPos } from './ui/sync';
import { parseComments, removeItem } from './comments/parse';
import { assignRounds } from './comments/assign';
import { resolveComment, type CommentResolution, type ResolveContext, type VersionData } from './comments/resolve';
import { annotateMarkdown } from './comments/export';
import { matchSections, type PairOverride, type SectionMatch } from './align/objects';
import { PairDialog, type PairRequest } from './ui/PairDialog';
import { BUILD, CHANGELOG_URL, newerBuild, type BuildInfo } from './version';
import { ContentsPanel } from './ui/ContentsPanel';
import { CommentsPanel, type History } from './ui/CommentsPanel';
import type { Mark } from './ui/marks';
import { clearWorkspaces, deleteWorkspace, getFile, listWorkspaces, putFile, saveWorkspace, workspaceTitle, type Workspace } from './pdf/workspaces';

export interface Version {
  id: number;
  name: string;
  /** SHA-256 of the file: identity across sessions. */
  hash: string;
  bytes: ArrayBuffer;
  pdf: PDFDocumentProxy | null;
  sizes: PageSize[];
  doc: DocModel | null;
  progress: number;
  error: string | null;
  label: string;
  /** Version printed in the document when it differs from the file name's. */
  titleLabel?: string | null;
}

let nextId = 1;

function versionInName(name: string): string | null {
  const m = /(?:^|[^a-z])v(\d+(?:[._]\d+)*)/i.exec(name);
  return m ? `v${m[1].replace(/_/g, '.')}` : null;
}

function labelFromName(name: string): string {
  return versionInName(name) ?? name.replace(/\.pdf$/i, '');
}

/** The file name wins over the title page (which may be wrong); the title page is the fallback. */
function resolveLabel(name: string, docLabel: string): { label: string; titleLabel: string | null } {
  const fromName = versionInName(name);
  if (!fromName) return { label: docLabel, titleLabel: null };
  // v1, v1.0 and v1.0.0 are the same version
  const norm = (l: string) => l.replace(/(\.0+)+$/, '');
  return { label: fromName, titleLabel: /^v\d/.test(docLabel) && norm(docLabel) !== norm(fromName) ? docLabel : null };
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
  const [newBuild, setNewBuild] = useState<BuildInfo | null>(null);
  useEffect(() => {
    newerBuild().then(setNewBuild);
    const again = () => document.visibilityState === 'visible' && newerBuild().then((b) => b && setNewBuild(b));
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, []);
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
  const [tab, setTab] = useState<'changes' | 'contents' | 'comments'>('changes');
  const [theme, setTheme] = useState<'auto' | 'light' | 'dark'>(() => (storageGet('pdfdiff.theme') as 'light' | 'dark' | null) ?? 'auto');
  useEffect(() => {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    storageSet('pdfdiff.theme', theme === 'auto' ? '' : theme);
  }, [theme]);
  const [commentText, setCommentText] = useState('');
  const [roundOverride, setRoundOverride] = useState<Map<number, number | null>>(new Map());
  // Pairings chosen by the user, per "oldHash:newHash".
  const [pairOv, setPairOv] = useState<Record<string, PairOverride[]>>({});
  const pairOvRef = useRef(pairOv);
  pairOvRef.current = pairOv;
  const [repairId, setRepairId] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [undo, setUndo] = useState<{ text: string; label: string } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(t);
  }, [undo]);
  const alignCache = useRef(new Map<string, Alignment>());
  const objCache = useRef(new Map<string, ObjectMatch[]>());
  const secCache = useRef(new Map<string, SectionMatch[]>());
  const ctlA = useMemo(() => new PaneControl(), []);
  const ctlB = useMemo(() => new PaneControl(), []);
  const fileInput = useRef<HTMLInputElement>(null);
  const versionsRef = useRef<Version[]>([]);
  const activeLoads = useRef(new Map<number, string>());
  versionsRef.current = versions;
  const [storageNote, setStorageNote] = useState<string | null>(null);
  // The saved comparison this view belongs to.
  const wsIdRef = useRef<string | null>(null);
  const [wsMeta, setWsMeta] = useState<{ title: string; custom: boolean; created: number } | null>(null);
  const [recent, setRecent] = useState<Workspace[]>([]);
  const restoring = useRef(true);
  const pendingScroll = useRef<Workspace['scroll'] | null>(null);

  // Fit the typical (median) page width into a pane until the user zooms;
  // wider pages, like a landscape table, get their own smaller scale.
  const [paneWidth, setPaneWidth] = useState(0);
  useEffect(() => {
    const el = panesRef.current;
    if (!el) return;
    const measure = () => {
      const cols = [...el.querySelectorAll<HTMLElement>('.pane')];
      if (cols.length) setPaneWidth(Math.min(...cols.map((c) => c.clientWidth)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [versions.map((v) => `${v.id}:${v.sizes.length}`).join(), left, right]);
  const fitWidth = Math.max(100, paneWidth - 2 * PANE_PAD - 2);
  useEffect(() => {
    const widths = versions
      .filter((v) => v.id === left || v.id === right)
      .flatMap((v) => v.sizes.map((s) => s.width))
      .sort((a, b) => a - b);
    const median = widths.length ? widths[widths.length >> 1] : 595;
    if (paneWidth) setFitScale(Math.max(0.3, Math.min(3, fitWidth / median)));
  }, [paneWidth, versions, left, right]);
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

  /** Load one PDF (from a drop or a saved comparison). Returns its version id. */
  const addVersion = useCallback(
    (bytes: ArrayBuffer, name: string, hash: string, store: boolean): number => {
      for (const [id, loadedHash] of activeLoads.current) if (loadedHash === hash) return id;
      const id = nextId++;
      activeLoads.current.set(id, hash);
      for (const old of versionsRef.current) if (old.hash === hash) void old.pdf?.loadingTask.destroy();
      const v: Version = { id, name, hash, bytes, pdf: null, sizes: [], doc: null, progress: 0, error: null, label: labelFromName(name) };
      setVersions((vs) => sortVersions([...vs.filter((x) => x.hash !== hash), v]));
      const fail = (error: unknown) => {
        activeLoads.current.delete(id);
        update(id, { error: error instanceof Error ? error.message : String(error) });
      };
      openForDisplay(bytes)
        .then(({ pdf, sizes }) => {
          if (activeLoads.current.has(id)) update(id, { pdf, sizes });
          else void pdf.loadingTask.destroy();
        })
        .catch(fail);
      (async () => {
        let doc = await getCached(hash);
        if (doc) doc.name = name;
        else {
          doc = await extractInBrowser(bytes, name, (d, t) => update(id, { progress: d / t }));
          putCached(hash, doc);
        }
        update(id, { doc, ...resolveLabel(name, doc.label), progress: 1 });
      })().catch(fail);
      if (store) putFile(hash, bytes, name).catch(() => setStorageNote('This browser did not allow storing the PDFs; the comparison will not be restored after a reload.'));
      return id;
    },
    [update],
  );

  const addFiles = useCallback(
    async (files: Iterable<File>) => {
      for (const f of files) {
        if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') continue;
        const bytes = await f.arrayBuffer();
        const hash = await sha256(bytes);
        if (versionsRef.current.some((v) => v.hash === hash && !v.error)) continue;
        addVersion(bytes, f.name, hash, true);
      }
    },
    [addVersion],
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

  // ---- Saved comparisons: restore the last one, save every change ----
  const closeAll = () => {
    activeLoads.current.clear();
    for (const v of versionsRef.current) v.pdf?.loadingTask.destroy();
    setVersions([]);
    alignCache.current.clear();
    objCache.current.clear();
    secCache.current.clear();
    setSelected(null);
    setCompare(null);
    setUndo(null);
    setRepairId(null);
    pendingScroll.current = null;
  };

  const restore = async (ws: Workspace) => {
    restoring.current = true;
    closeAll();
    // Read all files first, so the versions appear together.
    const files = await Promise.all(ws.versions.map((v) => getFile(v.hash).catch(() => null)));
    const ids = new Map<string, number>();
    ws.versions.forEach((v, i) => {
      const f = files[i];
      if (f) ids.set(v.hash, addVersion(f.bytes, v.name, v.hash, false));
    });
    if (files.some((f) => !f)) setStorageNote('Some PDFs of this comparison were no longer stored; add them again.');
    const id = (h: string | null) => (h ? (ids.get(h) ?? null) : null);
    setLeft(id(ws.left));
    setRight(id(ws.right));
    setPairChosen(ws.pairChosen);
    setFilters({ ...DEFAULT_FILTERS, ...ws.filters });
    setZoom(ws.zoom);
    setSync(ws.sync);
    setTab(ws.tab);
    setCommentText(ws.comments);
    setRoundOverride(new Map(ws.roundOverride.map(([r, h]) => [r, id(h)])));
    setPairOv(ws.pairOverrides ?? {});
    setDone(new Set(ws.done));
    pendingScroll.current = ws.scroll;
    wsIdRef.current = ws.id;
    setWsMeta({ title: ws.title, custom: ws.customTitle, created: ws.created });
    restoring.current = false;
  };

  useEffect(() => {
    (async () => {
      try {
        const list = await listWorkspaces();
        setRecent(list);
        if (list[0]) await restore(list[0]);
        else {
          // Comments pasted before comparisons were saved.
          const old = storageGet('pdfdiff.comments');
          if (old) setCommentText(old);
        }
        storageSet('pdfdiff.comments', '');
      } catch {
        setStorageNote('Saved comparisons are unavailable in this browser (private window or blocked storage).');
      } finally {
        restoring.current = false;
      }
    })();
  }, []);

  const doSave = useRef<() => Promise<void>>(async () => {});
  doSave.current = async () => {
    if (restoring.current) return;
    const vs = versionsRef.current;
    if (!vs.length) {
      // All versions of this comparison were removed.
      if (wsIdRef.current) await deleteWorkspace(wsIdRef.current).catch(() => {});
      wsIdRef.current = null;
      setWsMeta(null);
      return;
    }
    if (!vs.every((v) => v.hash)) return;
    const hashOf = (id: number | null) => vs.find((v) => v.id === id)?.hash ?? null;
    const versionsW = vs.map((v) => ({ hash: v.hash, name: v.name, label: v.label }));
    const id = wsIdRef.current ?? crypto.randomUUID();
    wsIdRef.current = id;
    const title = wsMeta?.custom ? wsMeta.title : workspaceTitle(versionsW, hashOf(left), hashOf(right));
    const created = wsMeta?.created ?? Date.now();
    if (!wsMeta || wsMeta.title !== title) setWsMeta({ title, custom: !!wsMeta?.custom, created });
    const ws: Workspace = {
      id,
      title,
      customTitle: !!wsMeta?.custom,
      created,
      updated: Date.now(),
      versions: versionsW,
      left: hashOf(left),
      right: hashOf(right),
      pairChosen,
      filters: { ...filters },
      zoom,
      sync,
      tab,
      scroll: { a: ctlA.centerPos(), b: ctlB.centerPos() },
      comments: commentText,
      roundOverride: [...roundOverride].map(([r, v]) => [r, v === null ? null : hashOf(v)]),
      done: [...done],
      pairOverrides: pairOv,
    };
    try {
      await saveWorkspace(ws);
    } catch {
      setStorageNote('Could not save this comparison (browser storage full or blocked).');
    }
  };
  const saveTimer = useRef(0);
  const scheduleSave = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => doSave.current(), 700);
  }, []);
  useEffect(scheduleSave, [versions.map((v) => `${v.hash}:${v.label}`).join(), left, right, pairChosen, filters, zoom, sync, tab, commentText, roundOverride, done, pairOv, wsMeta?.title]);
  useEffect(() => {
    const flush = () => doSave.current();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  // Back to the saved scroll positions once both panes have their pages.
  useEffect(() => {
    const p = pendingScroll.current;
    if (!p || !A?.sizes.length || !B?.sizes.length || !paneWidth) return;
    const t = setTimeout(() => {
      pendingScroll.current = null;
      if (p.a) ctlA.setCenter(p.a);
      if (p.b) ctlB.setCenter(p.b);
    }, 300);
    return () => clearTimeout(t);
  }, [A?.sizes.length, B?.sizes.length, paneWidth, fitScale]);

  const newComparison = async () => {
    await doSave.current();
    wsIdRef.current = null;
    setWsMeta(null);
    restoring.current = true;
    closeAll();
    setCommentText('');
    setRoundOverride(new Map());
    setPairOv({});
    setDone(new Set());
    setPairChosen(false);
    setRecent(await listWorkspaces().catch(() => []));
    restoring.current = false;
  };

  const al = useMemo(() => (A?.doc && B?.doc ? getAlign({ id: A.id, doc: A.doc }, { id: B.id, doc: B.doc }) : null), [A?.doc, B?.doc]);

  const objectsFor = useCallback(
    (a: VersionData, b: VersionData) => {
      const ha = versionsRef.current.find((v) => v.id === a.id)?.hash;
      const hb = versionsRef.current.find((v) => v.id === b.id)?.hash;
      const ov = (ha && hb && pairOvRef.current[`${ha}:${hb}`]) || [];
      const key = `${a.id}:${b.id}:${JSON.stringify(ov)}`;
      let r = objCache.current.get(key);
      if (!r) {
        r = matchObjects(a.doc, b.doc, getAlign(a, b), ov);
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
  const objMatches = useMemo(
    () => (al && A?.doc && B?.doc ? objectsFor({ id: A.id, label: A.label, doc: A.doc }, { id: B.id, label: B.label, doc: B.doc }) : []),
    [al, pairOv],
  );
  const figs = useMemo(() => objMatches.filter((m) => m.kind === 'figure'), [objMatches]);
  const [figStatus, setFigStatus] = useState<Map<number, { status: FigureStatus; diffs: (number | null)[] }>>(new Map());
  const [figError, setFigError] = useState<string | null>(null);
  useEffect(() => {
    setSelected(null);
    setFigStatus(new Map());
    setFigError(null);
  }, [al, objMatches]);

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
      const opened = await Promise.allSettled([openForCompare(A.bytes), openForCompare(B.bytes)]);
      pa = opened[0].status === 'fulfilled' ? opened[0].value : null;
      pb = opened[1].status === 'fulfilled' ? opened[1].value : null;
      if (!pa || !pb) throw new Error('Could not open PDFs for figure comparison');
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
          if (!cancelled) setFigError('Some figures could not be compared. Their status is unknown; reopen this comparison to retry.');
          continue;
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
    })().catch(() => {
      if (cancelled) return;
      setFigError('Figures could not be compared. Their status is unknown; reopen this comparison to retry.');
    }).finally(async () => {
      await Promise.allSettled([pa?.loadingTask.destroy(), pb?.loadingTask.destroy()]);
    });
    return () => {
      cancelled = true;
    };
  }, [figs, A?.doc, B?.doc]);

  const statusOf = useCallback((m: ObjectMatch): FigureStatus => figStatus.get(m.id)?.status ?? m.status, [figStatus]);
  const figInfo = useCallback((m: ObjectMatch) => ({ status: statusOf(m), diffs: figStatus.get(m.id)?.diffs }), [statusOf, figStatus]);
  const anchors = useMemo(() => (al && A?.doc && B?.doc ? buildSyncMap(A.doc, B.doc, al) : null), [al]);

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
      if (status === 'changed') {
        detail = m.parts.length > 1 ? panelSummary(m, st?.diffs) : 'The graphic differs.';
      } else if (status === 'pending') detail = figError ? 'Comparison unavailable; change status unknown.' : 'Comparing the graphics…';
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
    // Renumbered floats and equations (their numbers are not part of the text comparison).
    const KIND: Record<string, string> = { figure: 'Figure', table: 'Table', equation: 'Eq.' };
    for (const m of objMatches) {
      if (!m.renumbered || m.a === null || m.b === null) continue;
      const oa = da.objects[m.a];
      const ob = db.objects[m.b];
      const fmt = (n: string) => (m.kind === 'equation' ? `(${n})` : n);
      out.push({
        key: `r${m.id}`,
        type: 'renum',
        label: `${KIND[m.kind]} ${fmt(oa.number)} → ${fmt(ob.number)}`,
        aPage: oa.page,
        bPage: ob.page,
        pos: ob.page * 1e4 + ob.box[1] - 0.1,
        section: secName(db, ob.lines[0] ?? -1),
      });
    }
    return out.sort((x, y) => x.pos - y.pos);
  }, [al, figs, objMatches, statusOf, figStatus, figError, anchors]);

  // ---- Review comments ----
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
    [A, B, versions, roundOverride, autoRounds, figStatus, getAlign, objectsFor, sectionsFor, pairOv],
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

  // ---- PDF export ----
  const [exportOpen, setExportOpen] = useState(false);
  const runExport = async (opts: ExportOptions) => {
    if (!al || !A?.doc || !B?.doc) return;
    const exportFilters: Filters = { text: true, numeric: true, equations: true, moved: true, figures: true, renumber: opts.minor, toc: opts.minor };
    const vis = (c: Alignment['changes'][number]) => changeVisible(c, exportFilters);
    const mA = sideMarks(A.doc, al, 'a', vis);
    const mB = sideMarks(B.doc, al, 'b', vis);
    addFigureMarks(mA, A.doc, figs, figInfo, 'a', CHANGED_THRESHOLD);
    addFigureMarks(mB, B.doc, figs, figInfo, 'b', CHANGED_THRESHOLD);
    const segs = (ss: { text: string; changed: boolean }[]) =>
      ss
        .filter((x) => x.changed)
        .map((x) => x.text)
        .join(' ');
    const items: SummaryItem[] = [];
    for (const e of entries) {
      if (!exportFilters[entryCategory(e)]) continue;
      if (e.type === 'text') {
        const c = e.change;
        const [text, tone] = badge(c);
        const o = segs(c.aSegs);
        const n = segs(c.bSegs);
        items.push({
          badge: text,
          tone,
          pages: `p.${c.aPage + 1} -> p.${c.bPage + 1}`,
          text:
            c.kind === 'moved' && c.move
              ? `"${c.move.first} ..." (${c.move.words} words) now follows "... ${c.move.afterB}"`
              : c.kind === 'insert'
                ? n
                : c.kind === 'delete'
                  ? o
                  : `${o}  ->  ${n}`,
          bPage: c.bPage,
          aPage: c.aPage,
          section: e.section,
        });
      } else if (e.type === 'figure') {
        const [text, tone] = FIG_BADGE[e.fig.status];
        items.push({ badge: text, tone: tone === 'num' ? 'fig' : tone, pages: `p.${(e.fig.aPage ?? -1) + 1 || '-'} -> p.${(e.fig.bPage ?? -1) + 1 || '-'}`, text: `${e.fig.title}: ${e.fig.detail}`, bPage: e.fig.bPage, aPage: e.fig.aPage, section: e.section });
      } else {
        items.push({ badge: 'Renumbered', tone: 'ren', pages: `p.${e.aPage + 1} -> p.${e.bPage + 1}`, text: e.label, bPage: e.bPage, aPage: e.aPage, section: e.section });
      }
    }
    const comments: SummaryItem[] = [];
    const specs: AnnotationSpec[] = [];
    if (opts.comments) {
      for (const r of resolutions) {
        if (r.unassigned || r.item.notes) continue;
        const ref = r.refs.find((x) => x.target);
        const where = r.refs.filter((x) => x.source || x.target).map((x) => `${x.source?.label ?? '?'} -> ${x.target?.label ?? '-'}`).join('; ');
        comments.push({ badge: r.status, tone: 'cmt', pages: where, text: r.item.text.replace(/\s+/g, ' '), bPage: ref?.target?.boxes[0]?.page ?? null, aPage: null, section: '' });
        if (ref?.target) {
          for (const x of ref.target.boxes) {
            if (!mB.has(x.page)) mB.set(x.page, []);
            mB.get(x.page)!.push({ box: x.box, cls: 'cmt', key: '' });
          }
          const first = ref.target.boxes[0];
          if (first) specs.push({ page: first.page, type: 'Text', rects: [first.box], tone: 'cmt', contents: `[${r.status}] ${where}\n${r.item.text}` });
        }
      }
    }
    const title = wsMeta?.title ?? `${A.label} vs ${B.label}`;
    const safe = (t: string) => t.replace(/[^\w.\- ]+/g, '_').trim();
    let bytes: Uint8Array;
    let file: string;
    if (opts.format === 'side') {
      bytes = await buildSideBySide({
        title,
        A: { label: A.label, name: A.name, bytes: A.bytes, doc: A.doc, marks: mA },
        B: { label: B.label, name: B.name, bytes: B.bytes, doc: B.doc, marks: mB },
        al,
        items,
        comments,
        appUrl: /^https?:/.test(location.protocol) ? location.origin + location.pathname : 'https://jorddyy.github.io/pdf-diff-viewer/',
      });
      file = `${safe(title.replace(/ · .*$/, ''))} ${A.label} vs ${B.label} diff.pdf`;
    } else {
      specs.push(...textChangeSpecs(B.doc, al, al.changes.filter(vis)));
      for (const m of figs) {
        const st = statusOf(m);
        if (st === 'identical' || st === 'pending') continue;
        const ob = m.b !== null ? B.doc.objects[m.b] : null;
        const oa = m.a !== null ? A.doc.objects[m.a] : null;
        const name = (ob ?? oa)?.number ? `Figure ${(ob ?? oa)!.number}` : 'Figure';
        if (st === 'removed' && oa) {
          const at = anchors && mapPos(anchors, 'a', { page: oa.page, y: oa.box[1] });
          if (at) specs.push({ page: at.page, type: 'Text', rects: [[40, at.y, 60, at.y + 20]], tone: 'del', contents: `${name} of ${A.label} was removed.` });
          continue;
        }
        if (!ob) continue;
        const states = panelStates(m, st, figStatus.get(m.id)?.diffs, 'b', ob.parts.length || 1, CHANGED_THRESHOLD);
        (ob.parts.length ? ob.parts : [ob.box]).forEach((box, j) => {
          const s2 = states[j];
          if (s2 === 'same' || s2 === 'pending') return;
          const panel = ob.parts.length > 1 ? ` panel (${'abcdefghijklmnopqrstuvwxyz'[j] ?? j + 1})` : '';
          specs.push({ page: ob.page, type: 'Square', rects: [box], tone: s2 === 'new' ? 'ins' : 'fig', contents: st === 'added' ? `New ${name.toLowerCase()}.` : `${name}${panel}: ${s2 === 'new' ? 'new' : 'changed'} since ${A.label}.` });
        });
      }
      bytes = await buildAnnotated(B.bytes, B.doc, specs, `Changes since ${A.label} (${A.name}), made with the PDF diff viewer`);
      file = `${safe(B.name.replace(/\.pdf$/i, ''))} - changes since ${A.label}.pdf`;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  const exportComments = useCallback(() => (B ? annotateMarkdown(commentText, resolutions, B.label) : commentText), [commentText, resolutions, B?.label]);

  const visibleChange = useCallback((c: Alignment['changes'][number]) => changeVisible(c, filters), [filters]);
  const figVisible = filters.figures;
  const marksA = useMemo(() => {
    if (!al || !A?.doc) return new Map();
    const m = sideMarks(A.doc, al, 'a', visibleChange);
    if (figVisible) addFigureMarks(m, A.doc, figs, figInfo, 'a', CHANGED_THRESHOLD);
    return m;
  }, [al, A?.doc, visibleChange, figs, figInfo, figVisible]);
  const marksB = useMemo(() => {
    if (!al || !B?.doc) return new Map();
    const m = sideMarks(B.doc, al, 'b', visibleChange);
    if (figVisible) addFigureMarks(m, B.doc, figs, figInfo, 'b', CHANGED_THRESHOLD);
    return m;
  }, [al, B?.doc, visibleChange, figs, figInfo, figVisible]);

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
        pairs: parts.map((p, i) => {
          const d = figStatus.get(m.id)?.diffs?.[i];
          const status: PanelState = p.a === null ? 'new' : p.b === null ? 'removed' : p.sameHash ? 'same' : d === undefined ? 'pending' : d === null || d > CHANGED_THRESHOLD ? 'changed' : 'same';
          const letter = letters[(p.b ?? p.a) ?? i] ?? String(i + 1);
          return {
            label: parts.length > 1 ? `Panel (${letter})` : 'Figure',
            status,
            diff: d ?? (p.sameHash ? 0 : null),
            a: oa && p.a !== null ? { pdf: A.pdf!, page: oa.page, rect: oa.parts[p.a] ?? oa.box } : null,
            b: ob && p.b !== null ? { pdf: B.pdf!, page: ob.page, rect: ob.parts[p.b] ?? ob.box } : null,
          };
        }),
      });
    },
    [figs, A, B, figStatus],
  );

  const repairReq = useMemo<PairRequest | null>(() => {
    const m = repairId === null ? undefined : objMatches.find((x) => x.id === repairId);
    if (!m || !A?.doc || !B?.doc) return null;
    // Fix the side that exists; for a paired object start from the old one.
    const side = m.a !== null ? 'a' : 'b';
    const oa = m.a !== null ? A.doc.objects[m.a] : null;
    const ob = m.b !== null ? B.doc.objects[m.b] : null;
    const fixed = side === 'a' ? oa! : ob!;
    if (!fixed.number) return null;
    const pool = (side === 'a' ? B.doc : A.doc).objects.filter((o) => o.kind === m.kind);
    return { kind: m.kind, fixed, side, current: side === 'a' ? ob : oa, pool, aLabel: A.label, bLabel: B.label };
  }, [repairId, objMatches, A, B]);
  const applyPairing = (o: PairOverride) => {
    if (!A || !B) return;
    const key = `${A.hash}:${B.hash}`;
    setPairOv((all) => {
      // A new choice replaces earlier ones that touch the same objects.
      const rest = (all[key] ?? []).filter((x) => x.kind !== o.kind || ((o.a === null || (x.a !== o.a)) && (o.b === null || x.b !== o.b)));
      return { ...all, [key]: [...rest, o] };
    });
    setRepairId(null);
  };

  const select = useCallback(
    (key: string) => {
      if (!al || !A?.doc || !B?.doc) return;
      // Navigation scrolls both panes itself; do not let one drag the other.
      leader.current = { side: null, until: 0, down: false };
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
      const m = (key.startsWith('r') ? objMatches : figs).find((x) => x.id === +key.slice(1));
      if (!m) return;
      const oa = m.a !== null ? A.doc.objects[m.a] : null;
      const ob = m.b !== null ? B.doc.objects[m.b] : null;
      if (oa) ctlA.scrollTo({ page: oa.page, y: (oa.box[1] + oa.box[3]) / 2 }, true);
      if (ob) ctlB.scrollTo({ page: ob.page, y: (ob.box[1] + ob.box[3]) / 2 }, true);
      const other = oa && !ob ? anchors && mapPos(anchors, 'a', { page: oa.page, y: oa.box[1] }) : !oa && ob ? anchors && mapPos(anchors, 'b', { page: ob.page, y: ob.box[1] }) : null;
      if (other) (oa ? ctlB : ctlA).scrollTo(other, true);
    },
    [al, figs, objMatches, anchors, A?.doc, B?.doc, ctlA, ctlB, resolutions, roundOverride, autoRounds],
  );

  const secMatches = useMemo(() => (al && A?.doc && B?.doc ? sectionsFor({ id: A.id, label: A.label, doc: A.doc }, { id: B.id, label: B.label, doc: B.doc }) : []), [al]);
  const goToSection = (m: SectionMatch) => {
    if (!A?.doc || !B?.doc) return;
    leader.current = { side: null, until: 0, down: false };
    const sa = m.a !== null ? A.doc.sections[m.a] : null;
    const sb = m.b !== null ? B.doc.sections[m.b] : null;
    const pa = sa ? { page: sa.page, y: sa.y } : sb && anchors ? mapPos(anchors, 'b', { page: sb.page, y: sb.y }) : null;
    const pb = sb ? { page: sb.page, y: sb.y } : sa && anchors ? mapPos(anchors, 'a', { page: sa.page, y: sa.y }) : null;
    if (pa) ctlA.scrollToDest(pa);
    if (pb) ctlB.scrollToDest(pb);
  };

  // A click on a highlight shows its entry in the sidebar (centred, flashing),
  // also when it was already selected.
  const [reveal, setReveal] = useState<{ key: string; n: number } | null>(null);
  const onMarkClick = useCallback(
    (key: string) => {
      select(key);
      setTab(key.startsWith('c') ? 'comments' : 'changes');
      setReveal((r) => ({ key, n: (r?.n ?? 0) + 1 }));
      if (key.startsWith('f')) openCompare(+key.slice(1));
    },
    [select, openCompare],
  );

  // Synchronised scrolling: only the pane the user is actually scrolling leads.
  // The follower's own scroll events are ignored, so the panes never push each other.
  const leader = useRef<{ side: Side | null; until: number; down: boolean }>({ side: null, until: 0, down: false });
  const followRef = useRef<Follower | null>(null);
  const onUserInput = (side: Side, kind: InputKind) => {
    const now = performance.now();
    if (kind === 'up') leader.current = { side: leader.current.side, until: now + 400, down: false };
    else leader.current = { side, until: now + 400, down: kind === 'down' };
  };
  const goToPage = (side: Side, page: number) => {
    leader.current = { side: null, until: 0, down: false };
    const [from, to] = side === 'a' ? [ctlA, ctlB] : [ctlB, ctlA];
    from.scrollToPage(page);
    const pos = sync && anchors ? from.centerPos() : null;
    const target = pos && mapPos(anchors!, side, pos);
    if (target) to.setCenter(target);
    scheduleSave();
  };

  const onScroll = (side: Side) => {
    scheduleSave();
    const L = leader.current;
    const now = performance.now();
    if (L.side !== side || (!L.down && now > L.until)) return;
    // Smooth-scroll animations continue after the last wheel event.
    L.until = Math.max(L.until, now + 150);
    if (sync && anchors) {
      const [from, to] = side === 'a' ? [ctlA, ctlB] : [ctlB, ctlA];
      const pos = from.centerPos();
      const target = pos && mapPos(anchors, side, pos);
      if (target) to.setCenter(target);
    }
    // The sidebar list follows the part of the new version on screen.
    let range = side === 'b' || (sync && anchors) ? ctlB.viewRange() : null;
    if (!range && anchors) {
      const r = ctlA.viewRange();
      const t = r && mapPos(anchors, 'a', r.top);
      const b = r && mapPos(anchors, 'a', r.bottom);
      range = t && b ? { top: t, bottom: b } : null;
    }
    if (range) followRef.current?.({ top: range.top.page * 1e4 + range.top.y, bottom: range.bottom.page * 1e4 + range.bottom.y });
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
      if (e.key === 'g') {
        const boxes = document.querySelectorAll<HTMLInputElement>('.pagebox input');
        boxes[boxes.length - 1]?.focus();
        e.preventDefault();
        return;
      }
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
        <h1>
          <button class="home" title="All comparisons / start a new one" onClick={newComparison} disabled={!versions.length}>
            PDF diff
          </button>
        </h1>
        <a class="ver" href={CHANGELOG_URL} target="_blank" rel="noopener" title={`Release notes · commit ${BUILD.commit}${BUILD.built ? ', built ' + BUILD.built.slice(0, 16).replace('T', ' ') + ' UTC' : ''}`}>
          v{BUILD.version}
        </a>
        {newBuild && (
          <button class="btn update" title={`Version ${newBuild.version} (${newBuild.commit}) is online. Reload to use it; saved comparisons stay.`} onClick={() => location.reload()}>
            Update available · reload
          </button>
        )}
        {wsMeta && versions.length > 0 && (
          <button
            class="ws-title"
            title="Rename this comparison"
            onClick={() => {
              const t = prompt('Name of this comparison', wsMeta.title);
              if (t && t.trim()) setWsMeta({ ...wsMeta, title: t.trim(), custom: true });
            }}
          >
            {wsMeta.title} ✎
          </button>
        )}
        <div class="versions">
          {versions.map((v) => (
            <span key={v.id} class={`vchip ${v.error ? 'err' : ''}`} title={v.error ?? (v.titleLabel ? `${v.name}\nThe document itself says ${v.titleLabel}` : v.name)}>
              {v.label}
              {v.titleLabel && <span class="vwarn"> ⚠ says {v.titleLabel}</span>}
              {!v.doc && !v.error && <span class="prog" style={{ width: `${Math.round(v.progress * 100)}%` }} />}
              <button
                class="x"
                title={`Remove ${v.name}`}
                onClick={() => {
                  v.pdf?.loadingTask.destroy();
                  activeLoads.current.delete(v.id);
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
          {al && (
            <button class="btn" title="Export the comparison as a PDF to send to others" onClick={() => setExportOpen(true)}>
              ⤓ Export
            </button>
          )}
          <button
            class="btn"
            title="Colour theme: follow the system, light or dark"
            onClick={() => setTheme((t) => (t === 'auto' ? 'light' : t === 'light' ? 'dark' : 'auto'))}
          >
            {theme === 'auto' ? '◐ Auto' : theme === 'light' ? '☀ Light' : '☾ Dark'}
          </button>
          {versions.length > 0 && (
            <label class="sync">
              <input type="checkbox" checked={sync} onChange={(e) => setSync(e.currentTarget.checked)} /> Sync scroll
            </label>
          )}
          {versions.length > 0 && (
            <>
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
            </>
          )}
        </div>
      </header>
      {storageNote && (
        <div class="storage-note" role="status">
          {storageNote}{' '}
          <button class="link" onClick={() => setStorageNote(null)}>
            Dismiss
          </button>
        </div>
      )}

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
                  if (!confirm('Remove all saved comparisons, stored PDFs and cached analyses from this browser?')) return;
                  await clearCache();
                  await clearWorkspaces().catch(() => {});
                  storageSet('pdfdiff.comments', '');
                  setCommentText('');
                  setRecent([]);
                }}
              >
                Clear stored data
              </button>
            </p>
            <p class="small">Keys: j/n next change, k/p previous, g go to page; in the figure comparison 1–4 switch views, Esc closes.</p>
            {recent.length > 0 && (
              <section class="recent">
                <h3>Recent comparisons</h3>
                <ul>
                  {recent.map((w) => (
                    <li key={w.id}>
                      <button class="link title" onClick={() => restore(w)}>
                        {w.title}
                      </button>
                      <span class="small">
                        {w.versions.map((v) => v.label).join(', ')} · {new Date(w.updated).toLocaleString()}
                      </span>
                      <span class="acts">
                        <button
                          class="btn icon"
                          title="Rename"
                          onClick={async () => {
                            const t = prompt('Name of this comparison', w.title);
                            if (!t || !t.trim()) return;
                            await saveWorkspace({ ...w, title: t.trim(), customTitle: true }).catch(() => {});
                            setRecent(await listWorkspaces().catch(() => []));
                          }}
                        >
                          ✎
                        </button>
                        <button
                          class="btn icon"
                          title="Delete this saved comparison"
                          onClick={async () => {
                            if (!confirm(`Delete “${w.title}”?`)) return;
                            await deleteWorkspace(w.id).catch(() => {});
                            setRecent(await listWorkspaces().catch(() => []));
                          }}
                        >
                          ×
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </main>
      ) : (
        <main class="work">
          <aside class="side">
            <div class="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'changes'} class={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
                Changes
              </button>
              <button role="tab" aria-selected={tab === 'contents'} class={tab === 'contents' ? 'on' : ''} onClick={() => setTab('contents')}>
                Contents
              </button>
              <button role="tab" aria-selected={tab === 'comments'} class={tab === 'comments' ? 'on' : ''} onClick={() => setTab('comments')}>
                Comments{parsed ? ` (${parsed.items.filter((i) => !i.notes).length})` : ''}
              </button>
            </div>
            {tab === 'comments' ? (
              <CommentsPanel
                reveal={reveal}
                follow={followRef}
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
                done={done}
                toggleDone={(k) =>
                  setDone((d) => {
                    const n = new Set(d);
                    if (n.has(k)) n.delete(k);
                    else n.add(k);
                    return n;
                  })
                }
                onDelete={(item) => {
                  setUndo({ text: commentText, label: 'Comment deleted' });
                  setCommentText(removeItem(commentText, item));
                }}
                onClearAll={() => {
                  setUndo({ text: commentText, label: 'Comments removed' });
                  setCommentText('');
                  setRoundOverride(new Map());
                }}
              />
            ) : tab === 'contents' && A?.doc && B?.doc && al ? (
              <ContentsPanel
                sectionsA={A.doc.sections}
                sectionsB={B.doc.sections}
                matches={secMatches}
                entries={entries}
                filters={filters}
                follow={followRef}
                onGo={goToSection}
              />
            ) : A && B ? (
              al ? (
                <ChangeList
                  entries={entries}
                  filters={filters}
                  setFilters={setFilters}
                  selected={selected}
                  onSelect={select}
                  reveal={reveal}
                  follow={followRef}
                  onCompare={openCompare}
                  onRepair={setRepairId}
                  note={figError ?? (figs.some((m) => statusOf(m) === 'pending') ? 'Comparing figures in the background…' : undefined)}
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
                    <strong>{v.label}</strong>
                    {v.sizes.length > 0 && <PageBox control={i === 0 ? ctlA : ctlB} numPages={v.sizes.length} onGo={(p) => goToPage(i === 0 ? 'a' : 'b', p)} />}
                    <span class="fname">{v.name}</span>
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
                      maxWidth={zoom === null ? fitWidth : null}
                      onScroll={() => onScroll(i === 0 ? 'a' : 'b')}
                      onUserInput={(k) => onUserInput(i === 0 ? 'a' : 'b', k)}
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
      {repairReq && <PairDialog req={repairReq} onApply={applyPairing} onClose={() => setRepairId(null)} />}
      {exportOpen && A && B && (
        <ExportDialog aLabel={A.label} bLabel={B.label} hasComments={resolutions.length > 0} onExport={runExport} onClose={() => setExportOpen(false)} />
      )}
      {undo && (
        <div class="toast" role="status">
          {undo.label}.{' '}
          <button
            class="link"
            onClick={() => {
              setCommentText(undo.text);
              setUndo(null);
            }}
          >
            Undo
          </button>
        </div>
      )}
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

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** "(b), (d) changed · (e) new · (c) removed", using the panel letters of each version. */
function panelSummary(m: ObjectMatch, diffs: (number | null)[] | undefined): string {
  const nb = Math.max(0, ...m.parts.map((p) => (p.b ?? -1) + 1));
  const na = Math.max(0, ...m.parts.map((p) => (p.a ?? -1) + 1));
  const sb = panelStates(m, 'changed', diffs, 'b', nb, CHANGED_THRESHOLD);
  const sa = panelStates(m, 'changed', diffs, 'a', na, CHANGED_THRESHOLD);
  const list = (states: PanelState[], want: PanelState) =>
    states
      .map((st, i) => (st === want ? `(${LETTERS[i] ?? i + 1})` : ''))
      .filter(Boolean)
      .join(', ');
  const parts = [
    [list(sb, 'changed'), 'changed'],
    [list(sb, 'new'), 'new'],
    [list(sa, 'removed'), `removed (old numbering)`],
  ]
    .filter(([l]) => l)
    .map(([l, w]) => `${l} ${w}`);
  return parts.length ? parts.join(' · ') : 'The graphics differ.';
}
