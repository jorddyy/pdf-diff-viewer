import { useEffect, useRef, useState } from 'preact/hooks';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { Mark } from './marks';
import type { Pos } from './sync';

const GAP = 14;

/** Imperative handle on a pane: page geometry and scrolling. */
export class PaneControl {
  el: HTMLDivElement | null = null;
  scale = 1;
  tops: number[] = [];
  private quietUntil = 0;

  isQuiet(): boolean {
    return performance.now() < this.quietUntil;
  }

  /** Scroll so `pos` (page coordinates) is at the vertical centre, and `x` (if given) is in view. */
  scrollTo(pos: Pos, smooth = false, x?: [number, number]): void {
    if (!this.el || this.tops[pos.page] === undefined) return;
    const target = this.tops[pos.page] + pos.y * this.scale - this.el.clientHeight / 2;
    this.quietUntil = performance.now() + (smooth ? 600 : 120);
    let left = this.el.scrollLeft;
    const pageEl = this.el.querySelectorAll<HTMLElement>('.page')[pos.page];
    if (x && pageEl) {
      const x0 = pageEl.offsetLeft + x[0] * this.scale;
      const x1 = pageEl.offsetLeft + x[1] * this.scale;
      if (x0 < left || x1 > left + this.el.clientWidth) left = Math.max(0, (x0 + x1) / 2 - this.el.clientWidth / 2);
    }
    this.el.scrollTo({ top: Math.max(0, target), left, behavior: smooth ? 'smooth' : 'auto' });
  }

  centerPos(): Pos | null {
    if (!this.el || !this.tops.length) return null;
    const c = this.el.scrollTop + this.el.clientHeight / 2;
    let i = 0;
    while (i + 1 < this.tops.length && this.tops[i + 1] <= c) i++;
    return { page: i, y: (c - this.tops[i]) / this.scale };
  }
}

interface PaneProps {
  pdf: PDFDocumentProxy;
  pages: { width: number; height: number }[];
  scale: number;
  marks: Map<number, Mark[]>;
  selected: string | null;
  control: PaneControl;
  onMarkClick: (key: string) => void;
  onScroll: () => void;
}

export function PdfPane({ pdf, pages, scale, marks, selected, control, onMarkClick, onScroll }: PaneProps) {
  const tops: number[] = [];
  let y = GAP;
  for (const p of pages) {
    tops.push(y);
    y += p.height * scale + GAP;
  }
  control.tops = tops;
  control.scale = scale;
  const frame = useRef(0);
  return (
    <div
      class="pane"
      ref={(el) => {
        control.el = el;
      }}
      onScroll={() => {
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(onScroll);
      }}
    >
      <div class="pane-inner" style={{ paddingTop: `${GAP}px`, gap: `${GAP}px`, paddingBottom: `${GAP}px` }}>
        {pages.map((p, i) => (
          <PageView
            key={i}
            pdf={pdf}
            index={i}
            width={p.width}
            height={p.height}
            scale={scale}
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
  const [visible, setVisible] = useState(false);

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
    if (!visible) {
      // Free the bitmap of pages far out of view.
      c.width = 0;
      c.height = 0;
      return;
    }
    let task: RenderTask | null = null;
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
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, scale, pdf, index]);

  return (
    <div class="page" ref={ref} style={{ width: `${width * scale}px`, height: `${height * scale}px` }}>
      <canvas ref={canvas} />
      <div class="overlay">
        {marks?.map((m, k) => (
          <div
            key={k}
            class={`mk ${m.cls}${m.key === selected ? ' sel' : ''}`}
            title={m.title}
            style={{
              left: `${m.box[0] * scale - 1}px`,
              top: `${m.box[1] * scale - 1}px`,
              width: `${(m.box[2] - m.box[0]) * scale + 2}px`,
              height: `${(m.box[3] - m.box[1]) * scale + 2}px`,
            }}
            onClick={(e) => {
              e.stopPropagation();
              onMarkClick(m.key);
            }}
          />
        ))}
      </div>
      <div class="pno">{index + 1}</div>
    </div>
  );
}
