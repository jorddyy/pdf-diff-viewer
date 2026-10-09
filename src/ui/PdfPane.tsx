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
  /** Called (once per frame) when the pane scrolls, e.g. to update the page box. */
  listeners = new Set<() => void>();

  notify(): void {
    for (const f of this.listeners) f();
  }

  /** Put the top of a page at the top of the pane. */
  scrollToPage(page: number): void {
    if (!this.el || this.tops[page] === undefined) return;
    this.el.scrollTop = Math.max(0, this.tops[page] - 8);
  }

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

  /** Bring a link target (page coordinates) near the top of the pane, like a PDF viewer. */
  scrollToDest(pos: Pos): void {
    const el = this.el;
    if (!el || this.tops[pos.page] === undefined) return;
    el.scrollTop = Math.max(0, this.tops[pos.page] + pos.y * this.scaleOf(pos.page) - 40);
  }

  /** Put `pos` at the vertical centre immediately (synchronised scrolling). */
  setCenter(pos: Pos): void {
    const el = this.el;
    if (!el || this.tops[pos.page] === undefined) return;
    el.scrollTop = Math.max(0, this.tops[pos.page] + pos.y * this.scaleOf(pos.page) - el.clientHeight / 2);
  }

  /** Page position at a vertical offset (px) in the scrolled content. */
  posAt(px: number): Pos {
    let i = 0;
    while (i + 1 < this.tops.length && this.tops[i + 1] <= px) i++;
    return { page: i, y: (px - (this.tops[i] ?? 0)) / this.scaleOf(i) };
  }

  centerPos(): Pos | null {
    if (!this.el || !this.tops.length) return null;
    return this.posAt(this.el.scrollTop + this.el.clientHeight / 2);
  }

  /** Page positions at the top and bottom of the visible area. */
  viewRange(): { top: Pos; bottom: Pos } | null {
    if (!this.el || !this.tops.length) return null;
    return { top: this.posAt(this.el.scrollTop), bottom: this.posAt(this.el.scrollTop + this.el.clientHeight) };
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
        frame.current = requestAnimationFrame(() => {
          control.notify();
          onScroll();
        });
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
            onNavigate={(pos) => control.scrollToDest(pos)}
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
  onNavigate: (pos: Pos) => void;
}

/** A clickable link of the PDF: box in page coordinates (scale 1, top-left origin). */
interface PageLink {
  box: [number, number, number, number];
  url?: string;
  /** Resolved lazily: named destinations need a lookup. */
  dest?: unknown;
}

/** Page index and y (page coordinates, top-left origin) a PDF destination points at. */
async function resolveDest(pdf: PDFDocumentProxy, dest: unknown): Promise<Pos | null> {
  try {
    const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(d) || !d.length) return null;
    const page = typeof d[0] === 'number' ? d[0] : await pdf.getPageIndex(d[0]);
    const kind = d[1]?.name;
    // XYZ left top zoom / FitH top / FitBH top carry a vertical position; the others mean "the page".
    const top = kind === 'XYZ' ? d[3] : kind === 'FitH' || kind === 'FitBH' ? d[2] : null;
    if (typeof top !== 'number') return { page, y: 0 };
    const vp = (await pdf.getPage(page + 1)).getViewport({ scale: 1 });
    return { page, y: Math.max(0, vp.convertToViewportPoint(0, top)[1]) };
  } catch {
    return null;
  }
}

function PageView({ pdf, index, width, height, scale, marks, selected, onMarkClick, onNavigate }: PageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [hover, setHover] = useState<Mark | null>(null);
  const [links, setLinks] = useState<PageLink[]>([]);
  const [overLink, setOverLink] = useState<PageLink | null>(null);

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
      page
        .getAnnotations({ intent: 'display' })
        .then((anns) => {
          if (cancelled) return;
          const vp = page.getViewport({ scale: 1 });
          const out: PageLink[] = [];
          for (const a of anns) {
            if (a.subtype !== 'Link' || !a.rect || !(a.url || a.dest)) continue;
            const [x0, y0] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
            const [x1, y1] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
            out.push({ box: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)], url: a.url ?? undefined, dest: a.dest });
          }
          setLinks(out);
        })
        .catch(() => {});
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

  const pointOf = (e: MouseEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
  };

  /** The smallest link under a point. */
  const linkAt = (e: MouseEvent): PageLink | null => {
    if (!links.length) return null;
    const [x, y] = pointOf(e);
    let best: PageLink | null = null;
    let bestArea = Infinity;
    for (const l of links) {
      if (x < l.box[0] || x > l.box[2] || y < l.box[1] || y > l.box[3]) continue;
      const area = (l.box[2] - l.box[0]) * (l.box[3] - l.box[1]);
      if (area < bestArea) {
        bestArea = area;
        best = l;
      }
    }
    return best;
  };

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
      class={`page${hover || overLink ? ' over-mark' : ''}`}
      ref={ref}
      title={overLink ? (overLink.url ?? 'Go to the link target') + (hover ? '  (Alt-click: show the change entry)' : '') : hover?.title}
      style={{ width: `${width * scale}px`, height: `${height * scale}px` }}
      onMouseMove={(e) => {
        const m = markAt(e);
        if (m !== hover) setHover(m);
        const l = linkAt(e);
        if (l !== overLink) setOverLink(l);
      }}
      onMouseLeave={() => {
        setHover(null);
        setOverLink(null);
      }}
      onClick={(e) => {
        // A click that ends a text selection is not a navigation.
        if (window.getSelection()?.toString().trim()) return;
        // A link of the document wins over a highlight on the same words (a highlight
        // usually covers more than the link text); Alt-click picks the highlight.
        const l = e.altKey ? null : linkAt(e);
        if (l) {
          if (l.url) window.open(l.url, '_blank', 'noopener,noreferrer');
          else
            resolveDest(pdf, l.dest).then((pos) => {
              if (pos) onNavigate(pos);
            });
          return;
        }
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

/** "12 / 153": the page in the middle of the pane; type a number and Enter to go there. */
export function PageBox({ control, numPages, onGo }: { control: PaneControl; numPages: number; onGo: (page: number) => void }) {
  const [page, setPage] = useState(1);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setPage((control.centerPos()?.page ?? 0) + 1);
    control.listeners.add(update);
    update();
    return () => {
      control.listeners.delete(update);
    };
  }, [control]);
  const go = () => {
    const n = parseInt(text ?? '', 10);
    if (n >= 1 && n <= numPages) onGo(n - 1);
    setText(null);
  };
  return (
    <span class="pagebox">
      <input
        type="text"
        inputMode="numeric"
        aria-label="Go to page"
        title="Go to page (g)"
        value={text ?? String(page)}
        size={Math.max(2, String(numPages).length)}
        onFocus={(e) => {
          const input = e.currentTarget;
          setText(String(page));
          requestAnimationFrame(() => input.select());
        }}
        onInput={(e) => setText(e.currentTarget.value.replace(/[^0-9]/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            go();
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setText(null);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        onBlur={() => setText(null)}
      />
      <span class="small"> / {numPages}</span>
    </span>
  );
}
