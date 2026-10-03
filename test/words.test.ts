import { describe, expect, it } from 'vitest';
import { itemsToPieces } from '../src/extract/words';

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
