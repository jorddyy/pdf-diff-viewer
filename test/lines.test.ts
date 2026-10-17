import { describe, expect, it } from 'vitest';
import { buildLines, piecesToWords } from '../src/extract/lines';
import { detectLineNumbers } from '../src/extract/linenumbers';
import type { Piece } from '../src/extract/types';

const P = (text: string, x0: number, base: number, size = 12, spaceBefore = true, width = text.length * size * 0.5): Piece => ({
  text,
  x0,
  x1: x0 + width,
  base,
  size,
  top: base - 0.75 * size,
  bottom: base + 0.25 * size,
  spaceBefore,
});

describe('buildLines', () => {
  it('attaches sub- and superscripts to their line (B0s → Ds− π+)', () => {
    const pieces = [
      P('The', 72, 100),
      P('B', 100, 100),
      P('0', 106, 95.7, 8, false, 4),
      P('s', 106, 102.9, 8, false, 4),
      P('decays', 120, 100),
      P('next', 72, 114.4),
      P('line', 100, 114.4),
    ];
    const lines = buildLines(0, pieces, [], 12);
    expect(lines.map((l) => l.text)).toEqual(['The B0s decays', 'next line']);
  });

  it('numbers lines from the line-number column', () => {
    const marks = [
      { page: 0, base: 100, num: 41 },
      { page: 0, base: 114.4, num: 42 },
    ];
    // A subscript right after a word belongs to that word.
    const lines = buildLines(0, [P('first', 72, 100), P('x', 102, 102.5, 8, false, 4), P('second', 72, 114.4)], marks, 12);
    expect(lines.map((l) => [l.num, l.text])).toEqual([
      [41, 'firstx'],
      [42, 'second'],
    ]);
  });

  it('puts the radical sign on the line of its radicand', () => {
    const lines = buildLines(0, [P('energy', 72, 100), P('√', 120, 91.4, 12, true, 10), P('s', 130, 100, 12, false), P('previous', 72, 85.6)], [], 12);
    expect(lines.map((l) => l.text)).toEqual(['previous', 'energy √s']);
  });
});

describe('piecesToWords', () => {
  it('reads stacked scripts run by run: an asymmetric uncertainty stays legible', () => {
    // "4.52" with "+0.31" above "−0.27", split by font changes as pdf.js reports them.
    const words = piecesToWords([
      P('4.52', 100, 200, 12, true, 24),
      P('+0', 124, 196, 8, false, 8),
      P('−0', 124, 203, 8, false, 8),
      P('.', 132, 196, 8, false, 2),
      P('.', 132, 203, 8, false, 2),
      P('31', 134, 196, 8, false, 8),
      P('27', 134, 203, 8, false, 8),
    ]);
    expect(words.map((w) => w.text)).toEqual(['4.52+0.31−0.27']);
  });

  it('splits footnote marks off their words', () => {
    const after = piecesToWords([P('the', 72, 100, 11), P('pond', 92, 100, 11), P('freezes', 120, 100, 11, true, 40), P('1', 160, 96, 7, false, 4)]);
    expect(after.map((w) => [w.text, !!w.note])).toEqual([['the', false], ['pond', false], ['freezes', false], ['1', true]]);
    const before = piecesToWords([P('2', 72, 697, 7, true, 4), P('Only', 76, 700, 9, false, 18), P('parts', 96, 700, 9)]);
    expect(before.map((w) => [w.text, !!w.note])).toEqual([['2', true], ['Only', false], ['parts', false]]);
    // Exponents and subscripts stay with their base.
    expect(piecesToWords([P('10', 72, 100, 11, true, 11), P('3', 83, 96, 7, false, 4)]).map((w) => w.text)).toEqual(['103']);
    expect(piecesToWords([P('cos', 72, 100, 11, true, 17), P('2', 89, 96, 7, false, 4)]).map((w) => w.text)).toEqual(['cos2']);
  });
});

describe('buildLines in tables', () => {
  it('keeps a superscript that sticks out past the row end with its base ("× 10−3")', () => {
    const size = 10.9;
    const pieces = [
      P('sigma', 100, 200, size),
      P('21.06', 160, 200, size),
      P('±', 200, 200, size),
      P('1.98', 215, 200, size),
      P('p1', 100, 213.5, size),
      P('(−5.67', 130, 213.5, size),
      P('±', 170, 213.5, size),
      P('0.36)', 185, 213.5, size),
      P('×', 220, 213.5, size),
      P('10', 235, 213.5, size, true, 11),
      P('−', 246.5, 209.5, 7.97, false, 6.2),
      P('3', 252.7, 209.5, 7.97, false, 4),
    ];
    for (const marks of [[], [{ page: 0, base: 100, num: 7 }]]) {
      const lines = buildLines(0, pieces, marks, 12);
      expect(lines.map((l) => l.text)).toEqual(['sigma 21.06 ± 1.98', 'p1 (−5.67 ± 0.36) × 10−3']);
    }
  });
});

describe('piecesToWords', () => {
  it('splits at explicit spaces and clear gaps only', () => {
    const words = piecesToWords([P('eff', 72, 100, 12, true, 15), P('ects', 87.2, 100, 12, false, 20), P('of', 112, 100, 12, true)]);
    expect(words.map((w) => w.text)).toEqual(['effects', 'of']);
  });
});

describe('detectLineNumbers', () => {
  it('finds a right-aligned margin column counting up across pages', () => {
    let n = 1;
    const pages = [0, 1].map(() =>
      Array.from({ length: 30 }, (_, i) => {
        const num = String(n++);
        const x1 = 62;
        return [P(num, x1 - num.length * 3, 100 + i * 14.4, 6, true, num.length * 3), P('text', 72, 100 + i * 14.4)];
      }).flat(),
    );
    const res = detectLineNumbers(pages, 72, 523);
    expect(res.found).toBe(true);
    expect(res.marks[1][0].num).toBe(31);
    expect(res.pieces.size).toBe(60);
  });

  it('does not mistake table digits for line numbers', () => {
    const pages = [Array.from({ length: 30 }, (_, i) => [P(String((i * 7) % 13), 300, 100 + i * 14.4), P('row', 72, 100 + i * 14.4)]).flat()];
    expect(detectLineNumbers(pages, 72, 523).found).toBe(false);
  });
});
