import { describe, expect, it } from 'vitest';
import { pairPages } from '../src/export/pairing';
import { toUserQuad } from '../src/export/annotated';
import { winAnsi } from '../src/export/text';

describe('pairPages', () => {
  it('pairs each new page with the old page most of its text comes from', () => {
    const links: [number, number][] = [
      [0, 0],
      [1, 1],
      [1, 1],
      [1, 2],
      [2, 2],
      [3, 3],
    ];
    expect(pairPages(4, 4, links)).toEqual([
      { a: 0, b: 0 },
      { a: 1, b: 1 },
      { a: 2, b: 2 },
      { a: 3, b: 3 },
    ]);
  });

  it('inserts removed old pages next to their neighbours and leaves new pages unpaired', () => {
    const links: [number, number][] = [
      [0, 0],
      [1, 2],
      [2, 3],
    ];
    expect(pairPages(4, 4, links)).toEqual([
      { a: 0, b: 0 },
      { a: 1, b: null },
      { a: 2, b: 1 },
      { a: 3, b: 2 },
      { a: null, b: 3 },
    ]);
  });
});

describe('toUserQuad', () => {
  it('maps viewer rectangles back to PDF space on a normal page', () => {
    const vt: [number, number, number, number, number, number] = [1, 0, 0, -1, 0, 842];
    expect(toUserQuad(vt, [100, 200, 150, 212])).toEqual([
      [100, 642],
      [150, 642],
      [100, 630],
      [150, 630],
    ]);
  });

  it('maps back through a /Rotate 90 viewport', () => {
    const vt: [number, number, number, number, number, number] = [0, 1, 1, 0, 0, 0];
    // Viewer (x, y) = PDF (y, x).
    expect(toUserQuad(vt, [100, 300, 160, 312])[0]).toEqual([300, 100]);
  });
});

describe('winAnsi', () => {
  it('spells out characters the standard fonts lack', () => {
    expect(winAnsi('B0 → Ds+ π− (19.4 ± 1.8) × 10−6')).toBe('B0 -> Ds+ pi- (19.4 +/- 1.8) x 10-6');
    expect(winAnsi('Kraków, naïve')).toBe('Kraków, naïve');
    expect(winAnsi('eﬃcient')).toBe('efficient');
    expect(winAnsi('漢')).toBe('?');
  });
});
