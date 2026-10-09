import { describe, expect, it } from 'vitest';
import { CHANGED_THRESHOLD, inkDiff, type Raster } from '../src/figures/compare';

/** A made-up plot: frame, ticks, a curve and some blocks standing in for labels. */
function plot(opts: { scale?: number; dx?: number; dy?: number; extra?: boolean } = {}): Raster {
  const [w, h] = [240, 160];
  const { scale = 1, dx = 0, dy = 0, extra = false } = opts;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const dot = (x: number, y: number, r: number) => {
    for (let j = -r; j <= r; j++)
      for (let i = -r; i <= r; i++) {
        const px = Math.round(x + i);
        const py = Math.round(y + j);
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const p = (py * w + px) * 4;
        data[p] = data[p + 1] = data[p + 2] = 0;
      }
  };
  // Drawing coordinates are mapped about the centre, like a figure included at another size.
  const T = (x: number, y: number): [number, number] => [(w - 1) / 2 + (x - (w - 1) / 2) * scale + dx, (h - 1) / 2 + (y - (h - 1) / 2) * scale + dy];
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2 * scale);
    for (let k = 0; k <= n; k++) dot(...T(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n), 1);
  };
  line(30, 20, 210, 20);
  line(30, 140, 210, 140);
  line(30, 20, 30, 140);
  line(210, 20, 210, 140);
  for (let t = 0; t <= 8; t++) line(30 + t * 22.5, 140, 30 + t * 22.5, 132);
  let [px, py] = [30, 130];
  for (let x = 31; x <= 210; x++) {
    const y = 80 + 40 * Math.sin(x / 17) * Math.exp(-(x - 30) / 120);
    line(px, py, x, y);
    [px, py] = [x, y];
  }
  for (const [x, y] of [[60, 40], [120, 50], [170, 35]]) for (let k = 0; k < 14; k++) line(x + k, y, x + k, y + 8);
  if (extra) for (let k = 0; k < 40; k++) line(100 + k, 100, 100 + k, 125);
  return { data, width: w, height: h };
}

describe('inkDiff', () => {
  it('sees identical plots as identical', () => {
    expect(inkDiff(plot(), plot())).toBeLessThan(CHANGED_THRESHOLD);
  });

  it('tolerates a shift', () => {
    expect(inkDiff(plot(), plot({ dx: 3, dy: -2 }))).toBeLessThan(CHANGED_THRESHOLD);
  });

  it('tolerates a slightly different size of the same plot', () => {
    expect(inkDiff(plot(), plot({ scale: 1.05 }))).toBeLessThan(CHANGED_THRESHOLD);
    expect(inkDiff(plot(), plot({ scale: 0.95, dx: 2 }))).toBeLessThan(CHANGED_THRESHOLD);
  });

  it('still reports a real change', () => {
    expect(inkDiff(plot(), plot({ extra: true }))).toBeGreaterThan(CHANGED_THRESHOLD);
    expect(inkDiff(plot(), plot({ scale: 1.05, extra: true }))).toBeGreaterThan(CHANGED_THRESHOLD);
  });
});
