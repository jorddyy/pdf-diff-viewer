import { useEffect, useRef, useState } from 'preact/hooks';
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import type { Mark } from './marks';
import type { Pos } from './sync';

/** Vertical space between pages; the page number sits in it. */
const GAP = 18;
/** Horizontal padding around the pages. */
export const PANE_PAD = 14;

/** Imperative handle on a pane: page geometry and scrolling. */
export class PaneControl {
  el: HTMLDivElement | null = null;
  scales: number[] = [];
  tops: number[] = [];

  scaleOf(page: number): number {
    return this.scales[page] ?? 1;
  }

  /** Scroll so `pos` (page coordinates) is at the vertical centre; `x` is brought into view if needed. */
  scrollTo(pos: Pos, smooth = false, x?: [number, number]): void {
    const el = this.el;
    if (!el || this.tops[pos.page] === undefined) return;
    const s = this.scaleOf(pos.page);
    const top = this.tops[pos.page] + pos.y * s - el.clientHeight / 2;
    let left = el.scrollLeft;
    if (x && el.scrollWidth > el.clientWidth + 1) {
      const pageEl = el.querySelectorAll<HTMLElement>('.page')[pos.page];
      if (pageEl) {
        const x0 = pageEl.offsetLeft + x[0] * s;
        const x1 = pageEl.offsetLeft + x[1] * s;
        if (x0 < left || x1 > left + el.clientWidth) left = Math.max(0, (x0 + x1) / 2 - el.clientWidth / 2);
      }
    }
    el.scrollTo({ top: Math.max(0, top), left, behavior: smooth ? 'smooth' : 'auto' });
  }

  /** Put `pos` at the vertical centre immediately (synchronised scrolling). */
  setCenter(pos: Pos): void {
    const el = this.el;
    if (!el || this.tops[pos.page] === undefined) return;
    el.scrollTop = Math.max(0, this.tops[pos.page] + pos.y * this.scaleOf(pos.page) - el.clientHeight / 2);
  }

  centerPos(): Pos | null {
    if (!this.el || !this.tops.length) return null;
    const c = this.el.scrollTop + this.el.clientHeight / 2;
    let i = 0;
    while (i + 1 < this.tops.length && this.tops[i + 1] <= c) i++;
    return { page: i, y: (c - this.tops[i]) / this.scaleOf(i) };
  }
}

/** wheel/keys: a short burst; down/up: a drag of the scrollbar or a touch swipe. */
export type InputKind = 'scroll' | 'down' | 'up';

interface PaneProps {
  pdf: PDFDocumentProxy;
  pages: { width: number; height: number }[];
  scale: number;
  /** In fit mode: pages wider than this (px) get a smaller scale of their own (landscape pages). */
  maxWidth: number | null;
  marks: Map<number, Mark[]>;
  selected: string | null;
  control: PaneControl;
  onMarkClick: (key: string) => void;
  onScroll: () => void;
  /** The user scrolls this pane (wheel, keys) or starts/ends dragging it. */
  onUserInput: (kind: InputKind) => void;
}

export function PdfPane({ pdf, pages, scale, maxWidth, marks, selected, control, onMarkClick, onScroll, onUserInput }: PaneProps) {
  const scales = pages.map((p) => (maxWidth ? Math.min(scale, maxWidth / p.width) : scale));
  const tops: number[] = [];
  let y = GAP;
  pages.forEach((p, i) => {
    tops.push(y);
    y += p.height * scales[i] + GAP;
  });
  control.tops = tops;
  control.scales = scales;
  const frame = useRef(0);
  const elRef = useRef<HTMLDivElement | null>(null);

  // Content wider than the pane (zoomed in) starts centred.
  useEffect(() => {
    const el = elRef.current;
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, [scale, maxWidth]);

  return (
    <div
      class="pane"
      tabIndex={0}
      ref={(el) => {
        control.el = el;
        elRef.current = el;
      }}
      onScroll={() => {
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(onScroll);
      }}
      onWheel={() => onUserInput('scroll')}
      onPointerDown={() => onUserInput('down')}
      onPointerUp={() => onUserInput('up')}
      onPointerCancel={() => onUserInput('up')}
      onTouchStart={() => onUserInput('down')}
      onTouchEnd={() => onUserInput('up')}
      onKeyDown={(e) => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) onUserInput('scroll');
      }}
    >
      <div class="pane-inner" style={{ paddingTop: `${GAP}px`, gap: `${GAP}px`, paddingBottom: `${GAP}px`, paddingLeft: `${PANE_PAD}px`, paddingRight: `${PANE_PAD}px` }}>
        {pages.map((p, i) => (
          <PageView
            key={i}
            pdf={pdf}
            index={i}
            width={p.width}
            height={p.height}
            scale={scales[i]}
            marks={marks.get(i)}
            selected={selected}
            onMarkClick={onMarkClick}
          />
        ))}
      </div>
    </div>
  );
}

interface PageProps {
  pdf: PDFDocumentProxy;
  index: number;
  width: number;
  height: number;
  scale: number;
  marks?: Mark[];
  selected: string | null;
  onMarkClick: (key: string) => void;
}

function PageView({ pdf, index, width, height, scale, marks, selected, onMarkClick }: PageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [hover, setHover] = useState<Mark | null>(null);

  useEffect(() => {
    const el = ref.current!;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), {
      root: el.closest('.pane'),
      rootMargin: '120% 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current!;
    const textDiv = textRef.current!;
    if (!visible) {
      // Free the bitmap and text of pages far out of view.
      c.width = 0;
      c.height = 0;
      textDiv.replaceChildren();
      return;
    }
    let task: RenderTask | null = null;
    let text: TextLayer | null = null;
    let cancelled = false;
    (async () => {
      const page = await pdf.getPage(index + 1);
      if (cancelled) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * dpr });
      const off = document.createElement('canvas');
      off.width = Math.floor(viewport.width);
      off.height = Math.floor(viewport.height);
      task = page.render({ canvas: off, viewport });
      try {
        await task.promise;
      } catch {
        return;
      }
      if (cancelled) return;
      // Swap in the finished bitmap to avoid a blank flash while zooming.
      c.width = off.width;
      c.height = off.height;
      c.getContext('2d')!.drawImage(off, 0, 0);
      // Selectable text (also makes the browser's find work on the PDF).
      textDiv.replaceChildren();
      textDiv.style.setProperty('--total-scale-factor', String(scale));
      textDiv.style.setProperty('--scale-factor', String(scale));
      text = new TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport: page.getViewport({ scale }) });
      try {
        await text.render();
      } catch {
        // Cancelled.
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      text?.cancel();
    };
  }, [visible, scale, pdf, index]);

  /** The smallest mark under a point (page coordinates). */
  const markAt = (e: MouseEvent): Mark | null => {
    if (!marks?.length) return null;
    const r = ref.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / scale;
    const y = (e.clientY - r.top) / scale;
    let best: Mark | null = null;
    let bestArea = Infinity;
    for (const m of marks) {
      const pad = 2;
      if (x < m.box[0] - pad || x > m.box[2] + pad || y < m.box[1] - pad || y > m.box[3] + pad) continue;
      const area = (m.box[2] - m.box[0]) * (m.box[3] - m.box[1]);
      if (area < bestArea) {
        bestArea = area;
        best = m;
      }
    }
    return best;
  };

  return (
    <div
      class={`page${hover ? ' over-mark' : ''}`}
      ref={ref}
      title={hover?.title}
      style={{ width: `${width * scale}px`, height: `${height * scale}px` }}
      onMouseMove={(e) => {
        const m = markAt(e);
        if (m !== hover) setHover(m);
      }}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => {
        // A click that ends a text selection is not a navigation.
        if (window.getSelection()?.toString().trim()) return;
        const m = markAt(e);
        if (m) onMarkClick(m.key);
      }}
    >
      <canvas ref={canvas} />
      <div class="overlay">
        {marks?.map((m, k) => (
          <div
            key={k}
            class={`mk ${m.cls}${m.key === selected ? ' sel' : ''}`}
            style={{
              left: `${m.box[0] * scale - 1}px`,
              top: `${m.box[1] * scale - 1}px`,
              width: `${(m.box[2] - m.box[0]) * scale + 2}px`,
              height: `${(m.box[3] - m.box[1]) * scale + 2}px`,
            }}
          >
            {m.label && <span class="mk-label">{m.label}</span>}
          </div>
        ))}
      </div>
      <div class="textLayer" ref={textRef} />
      <div class="pno">{index + 1}</div>
    </div>
  );
}
