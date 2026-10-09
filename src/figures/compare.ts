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
  const [dx, dy] = searchShift(la, wa, ha, lb, wb, hb, maxFrac);
  return [dx, dy];
}

function searchShift(la: Float32Array, wa: number, ha: number, lb: Float32Array, wb: number, hb: number, maxFrac: number, coarseOnly = false): [number, number, number] {
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
  if (coarseOnly) return [bx, by, bestCost];
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
  return [bx, by, fine];
}

/** `l` magnified by `s` about its centre (same size, white where nothing is left). */
function scaleAbout(l: Float32Array, w: number, h: number, s: number): Float32Array {
  const out = new Float32Array(l.length);
  const [cx, cy] = [(w - 1) / 2, (h - 1) / 2];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = cx + (x - cx) / s;
      const sy = cy + (y - cy) / s;
      if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) {
        out[y * w + x] = 255;
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      out[y * w + x] = (l[y0 * w + x0] * (1 - fx) + l[y0 * w + x1] * fx) * (1 - fy) + (l[y1 * w + x0] * (1 - fx) + l[y1 * w + x1] * fx) * fy;
    }
  }
  return out;
}

/** A plot re-rendered at a slightly different size: scales tried besides 1. */
const SCALES = [0.9, 0.93, 0.96, 1.04, 1.07, 1.1];

/**
 * `b` registered onto `a`'s grid: best of a global shift and a small global
 * scale (a cropped or resized plot). A scale is only used when it clearly beats
 * the plain shift, so identical figures are never "improved" into a match.
 */
export function register(la: Float32Array, wa: number, ha: number, lb: Float32Array, wb: number, hb: number): { l: Float32Array; scaled: boolean } {
  let src = lb;
  const [, , base] = searchShift(la, wa, ha, lb, wb, hb, 0.04, true);
  if (base > 2) {
    let bestCost = base * 0.8; // needs a clear gain
    let bestS = 1;
    const tryScale = (s: number) => {
      const ls = scaleAbout(lb, wb, hb, s);
      const [, , c] = searchShift(la, wa, ha, ls, wb, hb, 0.04, true);
      if (c < bestCost) {
        bestCost = c;
        bestS = s;
        src = ls;
      }
    };
    for (const s of SCALES) tryScale(s);
    // Close in on the best scale.
    if (bestS !== 1) for (const step of [0.015, 0.007, 0.003]) for (const s of [bestS - step, bestS + step]) tryScale(s);
  }
  const [sx, sy] = bestShift(la, wa, ha, src, wb, hb);
  const out = new Float32Array(wa * ha);
  for (let y = 0; y < ha; y++) {
    for (let x = 0; x < wa; x++) {
      const xb = x + sx;
      const yb = y + sy;
      out[y * wa + x] = xb < 0 || yb < 0 || xb >= wb || yb >= hb ? 255 : src[yb * wb + xb];
    }
  }
  return { l: out, scaled: src !== lb };
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
  const reg = register(la, w, a.height, blur(luminance(b), w, b.height), w, b.height);
  const lb = reg.l;
  // A resampled plot has softer edges: allow two pixels instead of one.
  const tol = reg.scaled ? 2 : 1;
  let ink = 0;
  let diff = 0;
  const h = a.height;
  const at = (l: Float32Array, x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 255 : l[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const va = la[y * w + x];
      const vb = lb[y * w + x];
      if (va > 225 && vb > 225) continue;
      ink++;
      let best = Math.abs(va - vb);
      for (let dy = -tol; dy <= tol && best > 40; dy++) {
        for (let dx = -tol; dx <= tol && best > 40; dx++) {
          best = Math.min(best, Math.abs(va - at(lb, x + dx, y + dy)), Math.abs(at(la, x + dx, y + dy) - vb));
        }
      }
      if (best > 40) diff++;
    }
  }
  const ratio = diff / Math.max(ink, 50);
  // Resampling a plot leaves a noise floor of a percent or two that is not a change.
  return reg.scaled ? Math.max(0, ratio - SCALED_NOISE) : ratio;
}

const SCALED_NOISE = 0.02;

/** Bump when rendering, registration or the ink comparison changes, so cached figure results are ignored. */
export const COMPARE_VERSION = 1;

/** Threshold above which a figure panel is reported as changed. */
export const CHANGED_THRESHOLD = 0.01;

/** Difference image (after registration): ink only in the old version red, only in the new one green, shared ink grey. */
export function diffImage(a: Raster, b: Raster): ImageData {
  const w = a.width;
  const h = a.height;
  const la = luminance(a);
  const lb = register(la, a.width, a.height, luminance(b), b.width, b.height).l;
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const va = la[y * a.width + x];
      const vb = lb[y * w + x];
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
