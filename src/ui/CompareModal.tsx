import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Rect } from '../extract/types';
import { diffImage, rasterOf, renderRegionsToCanvases, type Raster } from '../figures/compare';
import DiffWorker from '../figures/diffWorker?worker&inline';

export interface RegionRef {
  pdf: PDFDocumentProxy;
  page: number;
  rect: Rect;
}

export interface ComparePair {
  label: string;
  /** Panel state, if known (figures). */
  status?: 'same' | 'changed' | 'new' | 'removed' | 'pending';
  /** Fraction of ink that differs. */
  diff?: number | null;
  a: RegionRef | null;
  b: RegionRef | null;
}

export interface CompareRequest {
  title: string;
  aLabel: string;
  bLabel: string;
  pairs: ComparePair[];
}

type Mode = 'side' | 'blink' | 'diff' | 'swipe';
const STATE_TEXT = { same: 'unchanged', changed: 'changed', new: 'new', removed: 'removed' } as const;
const MODES: [Mode, string][] = [
  ['side', 'Side by side'],
  ['blink', 'Blink'],
  ['diff', 'Difference'],
  ['swipe', 'Swipe'],
];

/** A panel's canvas; panels of one page share a single render. */
type Panels = (side: 'a' | 'b', ref: RegionRef) => Promise<HTMLCanvasElement>;

function urlOf(canvas: HTMLCanvasElement): Promise<string> {
  // toBlob encodes off the main thread, unlike toDataURL.
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : canvas.toDataURL())));
}

type Differ = ((a: Raster, b: Raster) => Promise<ImageData>) & { stop: () => void };

/** Difference images from a few workers; on the main thread if none starts. */
function differ(): Differ {
  const size = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 2));
  const workers: Worker[] = [];
  const waiting = new Map<number, { resolve: (d: ImageData) => void; reject: (e: Error) => void }>();
  let next = 0;
  const onmessage = (e: MessageEvent<{ id: number; data?: Uint8ClampedArray<ArrayBuffer>; width: number; height: number; error?: string }>) => {
    const w = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    if (e.data.data) w?.resolve(new ImageData(e.data.data, e.data.width, e.data.height));
    else w?.reject(new Error(e.data.error));
  };
  const run = (a: Raster, b: Raster) => {
    const id = next++;
    let worker = workers[id % size];
    if (!worker) {
      try {
        worker = new DiffWorker();
        worker.onmessage = onmessage;
        workers[id % size] = worker;
      } catch {
        return new Promise<ImageData>((resolve) => setTimeout(() => resolve(diffImage(a, b))));
      }
    }
    worker.postMessage({ id, a, b }, [a.data.buffer, b.data.buffer]);
    return new Promise<ImageData>((resolve, reject) => waiting.set(id, { resolve, reject }));
  };
  return Object.assign(run, { stop: () => workers.forEach((w) => w.terminate()) });
}

export function CompareModal({ req, onClose }: { req: CompareRequest; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('side');
  const diffs = useMemo(differ, []);
  useEffect(() => () => diffs.stop(), [diffs]);
  const panels = useMemo<Panels>(() => {
    const width = Math.min(760, Math.floor((window.innerWidth - 120) / 2) * 2);
    const pages = new Map<string, Promise<HTMLCanvasElement[]>>();
    return (side, ref) => {
      const group = req.pairs.flatMap((p) => {
        const r = p[side];
        return r && r.pdf === ref.pdf && r.page === ref.page ? [r] : [];
      });
      const key = `${side}${ref.page}`;
      let job = pages.get(key);
      if (!job) pages.set(key, (job = renderRegionsToCanvases(ref.pdf, ref.page, group.map((r) => r.rect), width)));
      return job.then((cs) => cs[group.indexOf(ref)]);
    };
  }, [req]);
  const [showSame, setShowSame] = useState(false);
  // Blink, difference and swipe need both versions of a panel.
  const comparable = req.pairs.some((p) => p.a && p.b);
  // Changed, new and removed panels first; unchanged panels only on request.
  const order = { changed: 0, new: 1, removed: 2, pending: 3, same: 4 } as const;
  const sorted = [...req.pairs].sort((x, y) => order[x.status ?? 'changed'] - order[y.status ?? 'changed']);
  const same = sorted.filter((p) => p.status === 'same');
  const shown = showSame || same.length === sorted.length ? sorted : sorted.filter((p) => p.status !== 'same');
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      const i = ['1', '2', '3', '4'].indexOf(e.key);
      if (i >= 0 && comparable) setMode(MODES[i][0]);
    };
    window.addEventListener('keydown', onKey);
    dialog.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, comparable]);
  return (
    <div class="modal-back" onClick={onClose}>
      <div class="modal" role="dialog" aria-label={req.title} onClick={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <strong>{req.title}</strong>
          {comparable && <div class="modes" role="tablist">
            {MODES.map(([m, label], i) => (
              <button key={m} role="tab" aria-selected={mode === m} class={`chip ${mode === m ? 'on' : ''}`} title={`${label} (${i + 1})`} onClick={() => setMode(m)}>
                {label}
              </button>
            ))}
          </div>}
          <button class="btn icon" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </div>
        {/* Focused so that arrow keys and Page Down scroll the panels. */}
        <div class="modal-body" tabIndex={-1} ref={dialog}>
          {shown.map((p, i) => (
            <PairView key={i} pair={p} panels={panels} diffs={diffs} mode={mode} aLabel={req.aLabel} bLabel={req.bLabel} />
          ))}
          {same.length > 0 && !showSame && (
            <button class="btn" onClick={() => setShowSame(true)}>
              Show {same.length} unchanged {same.length === 1 ? 'panel' : 'panels'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface Rendered {
  ca: HTMLCanvasElement | null;
  cb: HTMLCanvasElement | null;
  a: string | null;
  b: string | null;
  width: number;
}

function PairView({ pair, panels, diffs, mode, aLabel, bLabel }: { pair: ComparePair; panels: Panels; diffs: Differ; mode: Mode; aLabel: string; bLabel: string }) {
  const [img, setImg] = useState<Rendered | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [blinkB, setBlinkB] = useState(false);
  const [swipe, setSwipe] = useState(50);

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    (async () => {
      const [ca, cb] = await Promise.all([pair.a ? panels('a', pair.a) : null, pair.b ? panels('b', pair.b) : null]);
      const [a, b] = await Promise.all([ca && urlOf(ca), cb && urlOf(cb)]);
      for (const u of [a, b]) if (u) urls.push(u);
      if (cancelled) return;
      setImg({ ca, cb, a, b, width: (ca ?? cb)?.width ?? 0 });
    })().catch((error) => console.warn('Panel rendering failed', error));
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [pair, panels]);

  // The difference image needs a registration search: only on request.
  useEffect(() => {
    if (mode !== 'diff' || !img?.ca || !img.cb || diff) return;
    let cancelled = false;
    const { ca, cb } = img;
    diffs(rasterOf(ca), rasterOf(cb))
      .then((d) => {
        if (cancelled) return null;
        const c = document.createElement('canvas');
        c.width = d.width;
        c.height = d.height;
        c.getContext('2d')!.putImageData(d, 0, 0);
        return urlOf(c);
      })
      .then((url) => {
        if (url && !cancelled) setDiff(url);
        else if (url) URL.revokeObjectURL(url);
      }, (error) => console.warn('Difference image failed', error));
    return () => {
      cancelled = true;
    };
  }, [mode, img, diff]);
  useEffect(() => () => { if (diff) URL.revokeObjectURL(diff); }, [diff]);

  useEffect(() => {
    if (mode !== 'blink') return;
    const t = setInterval(() => setBlinkB((x) => !x), 700);
    return () => clearInterval(t);
  }, [mode]);

  if (!img) return <div class="pair-view loading">Rendering {pair.label}…</div>;
  const both = img.a && img.b;
  const effective: Mode = both ? mode : 'side';
  return (
    <figure class="pair-view">
      <figcaption>
        {pair.label}
        {pair.status && pair.status !== 'pending' && <span class={`pstate ${pair.status}`}>{STATE_TEXT[pair.status]}</span>}
        {pair.status === 'changed' && typeof pair.diff === 'number' && (
          <span class="small"> {pair.diff >= 0.999 ? 'different size or crop' : `${(100 * pair.diff).toFixed(1)}% of the ink differs`}</span>
        )}
      </figcaption>
      {effective === 'side' && (
        <div class="side-by-side">
          <div>
            <div class="tag old">{aLabel}</div>
            {img.a ? <img src={img.a} alt={`${pair.label}, ${aLabel}`} /> : <div class="missing">not in {aLabel}</div>}
          </div>
          <div>
            <div class="tag new">{bLabel}</div>
            {img.b ? <img src={img.b} alt={`${pair.label}, ${bLabel}`} /> : <div class="missing">not in {bLabel}</div>}
          </div>
        </div>
      )}
      {effective === 'blink' && (
        <div class="single">
          <div class={`tag ${blinkB ? 'new' : 'old'}`}>{blinkB ? bLabel : aLabel}</div>
          <img src={(blinkB ? img.b : img.a)!} alt={pair.label} />
        </div>
      )}
      {effective === 'diff' && (
        <div class="single">
          <div class="tag">
            <span class="legend old">only in {aLabel}</span> <span class="legend new">only in {bLabel}</span>
          </div>
          {diff ? <img src={diff} alt={`Difference of ${pair.label}`} /> : <div class="missing">Computing the difference…</div>}
        </div>
      )}
      {effective === 'swipe' && (
        <div class="single">
          <div class="tag">
            {aLabel} ← → {bLabel}
          </div>
          <div class="swipe">
            <img src={img.b!} alt={`${pair.label}, ${bLabel}`} style={{ width: `${img.width}px` }} />
            <div class="swipe-old" style={{ width: `${swipe}%` }}>
              <img src={img.a!} alt={`${pair.label}, ${aLabel}`} style={{ width: `${img.width}px` }} />
            </div>
            <input type="range" min={0} max={100} value={swipe} aria-label="Swipe position" onInput={(e) => setSwipe(+e.currentTarget.value)} />
          </div>
        </div>
      )}
    </figure>
  );
}
