import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Rect } from '../extract/types';

export interface Raster {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Render a page region to a canvas whose width is `width` pixels. */
export async function renderRegionToCanvas(pdf: PDFDocumentProxy, pageIndex: number, rect: Rect, width: number): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(pageIndex + 1);
  const s = width / Math.max(1, rect[2] - rect[0]);
  const viewport = page.getViewport({ scale: s });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((rect[2] - rect[0]) * s));
  canvas.height = Math.max(1, Math.round((rect[3] - rect[1]) * s));
  await page.render({ canvas, viewport, transform: [1, 0, 0, 1, -rect[0] * s, -rect[1] * s] }).promise;
  return canvas;
}

export function rasterOf(canvas: HTMLCanvasElement): Raster {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
}

function luminance(r: Raster): Float32Array {
  const out = new Float32Array(r.width * r.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const a = r.data[p + 3] / 255;
    // Transparent pixels count as white paper.
    out[i] = 255 * (1 - a) + a * (0.299 * r.data[p] + 0.587 * r.data[p + 1] + 0.114 * r.data[p + 2]);
  }
  return out;
}

function blur(l: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(l.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += l[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

/** Block-average a luminance image by an integer factor. */
function downsample(l: Float32Array, w: number, h: number, f: number): [Float32Array, number, number] {
  const W = Math.max(1, Math.floor(w / f));
  const H = Math.max(1, Math.floor(h / f));
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += l[(y * f + dy) * w + x * f + dx];
      out[y * W + x] = s / (f * f);
    }
  }
  return [out, W, H];
}

function shiftCost(la: Float32Array, lb: Float32Array, wa: number, ha: number, wb: number, hb: number, dx: number, dy: number, step: number): number {
  let cost = 0;
  let n = 0;
  for (let y = 0; y < ha; y += step) {
    const yb = y + dy;
    if (yb < 0 || yb >= hb) continue;
    for (let x = 0; x < wa; x += step) {
      const xb = x + dx;
      if (xb < 0 || xb >= wb) continue;
      const va = la[y * wa + x];
      const vb = lb[yb * wb + xb];
      if (va > 235 && vb > 235) continue;
      cost += Math.abs(va - vb);
      n++;
    }
  }
  return n ? cost / n : Infinity;
}

/**
 * Global offset (dx, dy) of b relative to a: coarse search on a downsampled
 * image, then refinement at full resolution. Floats are often placed a few
 * points differently between versions.
 */
export function bestShift(la: Float32Array, wa: number, ha: number, lb: Float32Array, wb: number, hb: number, maxFrac = 0.04): [number, number] {
  const f = Math.max(1, Math.floor(Math.max(wa, wb) / 160));
  const [sa, swa, sha] = downsample(la, wa, ha, f);
  const [sb, swb, shb] = downsample(lb, wb, hb, f);
  const r = Math.max(2, Math.ceil((maxFrac * Math.max(wa, ha)) / f));
  let best = [0, 0];
  let bestCost = shiftCost(sa, sb, swa, sha, swb, shb, 0, 0, 1);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const c = shiftCost(sa, sb, swa, sha, swb, shb, dx, dy, 1);
      if (c < bestCost - 0.01) {
        bestCost = c;
        best = [dx, dy];
      }
    }
  }
  let [bx, by] = [best[0] * f, best[1] * f];
  const step = Math.max(1, Math.floor(Math.max(wa, ha) / 400));
  let fine = shiftCost(la, lb, wa, ha, wb, hb, bx, by, step);
  const [cx, cy] = [bx, by];
  for (let dy = -f; dy <= f; dy++) {
    for (let dx = -f; dx <= f; dx++) {
      const c = shiftCost(la, lb, wa, ha, wb, hb, cx + dx, cy + dy, step);
      if (c < fine - 0.01) {
        fine = c;
        [bx, by] = [cx + dx, cy + dy];
      }
    }
  }
  return [bx, by];
}

/**
 * Fraction of the ink that differs between two renderings of the same width,
 * tolerating one-pixel shifts and anti-aliasing. 0 = identical, 1 = nothing in common.
 * Rasters whose heights differ by more than 3% count as completely changed.
 */
export function inkDiff(a: Raster, b: Raster): number {
  if (a.width !== b.width || Math.abs(a.height - b.height) > 0.03 * Math.max(a.height, b.height) + 1) return 1;
  const w = a.width;
  const la = blur(luminance(a), w, a.height);
  const lb = blur(luminance(b), w, b.height);
  const [sx, sy] = bestShift(la, w, a.height, lb, w, b.height);
  let ink = 0;
  let diff = 0;
  const at = (l: Float32Array, h: number, x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 255 : l[y * w + x]);
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < w; x++) {
      const va = la[y * w + x];
      const vb = at(lb, b.height, x + sx, y + sy);
      if (va > 225 && vb > 225) continue;
      ink++;
      let best = Math.abs(va - vb);
      for (let dy = -1; dy <= 1 && best > 40; dy++) {
        for (let dx = -1; dx <= 1 && best > 40; dx++) {
          best = Math.min(best, Math.abs(va - at(lb, b.height, x + sx + dx, y + sy + dy)), Math.abs(at(la, a.height, x + dx, y + dy) - vb));
        }
      }
      if (best > 40) diff++;
    }
  }
  return diff / Math.max(ink, 50);
}

/** Threshold above which a figure panel is reported as changed. */
export const CHANGED_THRESHOLD = 0.01;

/** Difference image (after registration): ink only in the old version red, only in the new one green, shared ink grey. */
export function diffImage(a: Raster, b: Raster): ImageData {
  const w = a.width;
  const h = a.height;
  const la = luminance(a);
  const lb = luminance(b);
  const [sx, sy] = bestShift(la, a.width, a.height, lb, b.width, b.height);
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const va = la[y * a.width + x];
      const xb = x + sx;
      const yb = y + sy;
      const vb = xb < 0 || yb < 0 || xb >= b.width || yb >= b.height ? 255 : lb[yb * b.width + xb];
      const p = (y * w + x) * 4;
      if (va < vb - 40) out.data.set([200, 40, 40, 255], p);
      else if (vb < va - 40) out.data.set([30, 150, 60, 255], p);
      else {
        const g = 255 - (255 - Math.min(va, vb)) * 0.35;
        out.data.set([g, g, g, 255], p);
      }
    }
  }
  return out;
}

/**
 * Render each page once and cut out several regions, each resampled to
 * `width` pixels. Much cheaper than one render per region for pages with many
 * panels, since the whole page content is executed for every render.
 */
export async function renderRegions(pdf: PDFDocumentProxy, pageIndex: number, rects: Rect[], width: number): Promise<Raster[]> {
  const page = await pdf.getPage(pageIndex + 1);
  const minW = Math.min(...rects.map((r) => Math.max(1, r[2] - r[0])));
  const s = Math.min(4, Math.max(1, width / minW));
  const viewport = page.getViewport({ scale: s });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return rects.map((r) => {
    const w = Math.max(1, r[2] - r[0]);
    const h = Math.max(1, r[3] - r[1]);
    const out = document.createElement('canvas');
    out.width = width;
    out.height = Math.max(1, Math.round((h * width) / w));
    const ctx = out.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, r[0] * s, r[1] * s, w * s, h * s, 0, 0, out.width, out.height);
    return rasterOf(out);
  });
}
