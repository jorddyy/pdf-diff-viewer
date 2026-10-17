import { describe, expect, it } from 'vitest';
import { itemsToPieces, sidewaysTurn } from '../src/extract/words';
import { multiply } from '../src/extract/geometry';

const quality = () => ({ glyphs: 0, suspicious: 0, ok: true });

describe('itemsToPieces', () => {
  it('reads upright text on a normal page', () => {
    // Portrait A4: viewport flips y.
    const vt: [number, number, number, number, number, number] = [1, 0, 0, -1, 0, 842];
    const pieces = itemsToPieces([{ str: 'Hello world', transform: [12, 0, 0, 12, 72, 700], width: 60, fontName: 'f' }], {}, vt, quality());
    expect(pieces.map((p) => p.text)).toEqual(['Hello', 'world']);
    expect(pieces[0].base).toBeCloseTo(142);
    expect(pieces[0].x0).toBeCloseTo(72);
  });

  it('keeps text that a /Rotate 90 page shows upright, and skips text rotated on screen', () => {
    // /Rotate 90 on a 595×842 page: viewport (842 wide) = PDF space rotated.
    const vt: [number, number, number, number, number, number] = [0, 1, 1, 0, 0, 0];
    // Text rotated in PDF space by the landscape environment, upright on screen.
    const upright = { str: 'Table 13', transform: [0, 12, -12, 0, 300, 100], width: 45, fontName: 'f' };
    // Text that is horizontal in PDF space appears vertical on this page.
    const sideways = { str: 'axis', transform: [12, 0, 0, 12, 300, 100], width: 20, fontName: 'f' };
    const pieces = itemsToPieces([upright, sideways], {}, vt, quality());
    expect(pieces.map((p) => p.text)).toEqual(['Table', '13']);
    expect(pieces[0].x0).toBeCloseTo(100);
    expect(pieces[0].base).toBeCloseTo(300);
  });
});

describe('sidewaysTurn', () => {
  const vt: [number, number, number, number, number, number] = [1, 0, 0, -1, 0, 842];
  const upwards = (str: string, x: number) => ({ str, transform: [0, 10, -10, 0, x, 200], width: 5 * str.length, fontName: 'f' });

  it('turns a page whose text mostly reads upwards, so it can be read left to right', () => {
    const items = [upwards('Table 1: An invented record of rainfall', 100), upwards('Spring 41.5 38 Summer 52.3 61', 125), { str: '31', transform: [10, 0, 0, 10, 290, 60], width: 10, fontName: 'f' }];
    const turn = sidewaysTurn(items, vt, 595, 842)!;
    expect(turn).not.toBeNull();
    const pieces = itemsToPieces(items, {}, multiply(vt, turn), quality());
    expect(pieces.slice(0, 3).map((p) => p.text)).toEqual(['Table', '1:', 'An']);
  });

  it('leaves a normal page with a rotated axis label alone', () => {
    const items = [{ str: 'A quiet garden stands beside the village library.', transform: [11, 0, 0, 11, 72, 700], width: 250, fontName: 'f' }, upwards('Rainfall', 80)];
    expect(sidewaysTurn(items, vt, 595, 842)).toBeNull();
  });
});
