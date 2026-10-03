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
