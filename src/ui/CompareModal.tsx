import { useEffect, useRef, useState } from 'preact/hooks';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Rect } from '../extract/types';
import { diffImage, rasterOf, renderRegionToCanvas } from '../figures/compare';

export interface RegionRef {
  pdf: PDFDocumentProxy;
  page: number;
  rect: Rect;
}

export interface ComparePair {
  label: string;
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
const MODES: [Mode, string][] = [
  ['side', 'Side by side'],
  ['blink', 'Blink'],
  ['diff', 'Difference'],
  ['swipe', 'Swipe'],
];

export function CompareModal({ req, onClose }: { req: CompareRequest; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('side');
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      const i = ['1', '2', '3', '4'].indexOf(e.key);
      if (i >= 0) setMode(MODES[i][0]);
    };
    window.addEventListener('keydown', onKey);
    dialog.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div class="modal-back" onClick={onClose}>
      <div class="modal" role="dialog" aria-label={req.title} tabIndex={-1} ref={dialog} onClick={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <strong>{req.title}</strong>
          <div class="modes" role="tablist">
            {MODES.map(([m, label], i) => (
              <button key={m} role="tab" aria-selected={mode === m} class={`chip ${mode === m ? 'on' : ''}`} title={`${label} (${i + 1})`} onClick={() => setMode(m)}>
                {label}
              </button>
            ))}
          </div>
          <button class="btn icon" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </div>
        <div class="modal-body">
          {req.pairs.map((p, i) => (
            <PairView key={i} pair={p} mode={mode} aLabel={req.aLabel} bLabel={req.bLabel} />
          ))}
        </div>
      </div>
    </div>
  );
}

interface Rendered {
  a: string | null;
  b: string | null;
  diff: string | null;
  width: number;
}

function PairView({ pair, mode, aLabel, bLabel }: { pair: ComparePair; mode: Mode; aLabel: string; bLabel: string }) {
  const [img, setImg] = useState<Rendered | null>(null);
  const [blinkB, setBlinkB] = useState(false);
  const [swipe, setSwipe] = useState(50);

  useEffect(() => {
    let cancelled = false;
    const width = Math.min(760, Math.floor((window.innerWidth - 120) / 2) * 2);
    (async () => {
      const ca = pair.a ? await renderRegionToCanvas(pair.a.pdf, pair.a.page, pair.a.rect, width) : null;
      const cb = pair.b ? await renderRegionToCanvas(pair.b.pdf, pair.b.page, pair.b.rect, width) : null;
      let diff: string | null = null;
      if (ca && cb) {
        const d = diffImage(rasterOf(ca), rasterOf(cb));
        const c = document.createElement('canvas');
        c.width = d.width;
        c.height = d.height;
        c.getContext('2d')!.putImageData(d, 0, 0);
        diff = c.toDataURL();
      }
      if (!cancelled) setImg({ a: ca?.toDataURL() ?? null, b: cb?.toDataURL() ?? null, diff, width });
    })();
    return () => {
      cancelled = true;
    };
  }, [pair]);

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
      <figcaption>{pair.label}</figcaption>
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
          <img src={img.diff!} alt={`Difference of ${pair.label}`} />
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
