import { describe, expect, it } from 'vitest';
import { classifyPair } from '../src/align/align';
import { captionStart } from '../src/extract/structure';

describe('classifyPair', () => {
  const c = (x: string, y: string, ...prev: string[]) => classifyPair(x, y, prev, false);

  it('reports changed values as number changes, even in parentheses', () => {
    expect(c('(1.23', '(1.31', '=')).toBe('numeric');
    expect(c('0.04)', '0.05)', '±')).toBe('numeric');
    expect(c('(12', '(15', '=')).toBe('numeric');
    expect(c('4.2%.', '4.7%.', 'is')).toBe('numeric');
    expect(c('1234', '1250', 'yield')).toBe('numeric');
  });

  it('reports reference numbers as renumbering', () => {
    expect(c('12', '14', 'Fig.')).toBe('renumber');
    expect(c('3.2', '4.2', 'Section')).toBe('renumber');
    expect(c('(13)', '(15)', 'Eq.')).toBe('renumber');
    expect(c('[23]', '[24]', 'in')).toBe('renumber');
    expect(c('[7,', '[9,', 'in')).toBe('renumber');
    expect(c('8]', '10]', '[7,')).toBe('renumber');
    expect(c('13', '15', 'and', '12', 'Figs.')).toBe('renumber');
    expect(c('13', '15', '12,', 'Tables')).toBe('renumber');
    expect(classifyPair('0.7', '0.9', ['explanation'], true)).toBe('renumber');
  });

  it('separates other edits', () => {
    expect(c('fDs', 'fDs+', 'the')).toBe('text');
    expect(c('kaons', 'pions', 'on')).toBe('text');
    expect(c('Fig.', 'Fig.', 'in')).toBe('same');
  });
});

describe('captionStart', () => {
  it('accepts captions with a colon', () => {
    expect(captionStart('Figure 3: Mass fit to the data.', false, false)).toEqual({ kind: 'figure', number: '3' });
    expect(captionStart('Table A.2: Fit parameters', false, false)).toEqual({ kind: 'table', number: 'A.2' });
  });

  it('rejects a sentence end that wrapped to the start of a line', () => {
    expect(captionStart('Fig. 23.', false, true)).toBeNull();
    expect(captionStart('Fig. 5. Since a D decays to three tracks, the', false, false)).toBeNull();
  });

  it('accepts the period form in a caption font or next to a graphic', () => {
    expect(captionStart('Fig. 5. Invariant mass of the candidates', true, false)).toEqual({ kind: 'figure', number: '5' });
    expect(captionStart('Fig. 5. Invariant mass of the candidates', false, true)).toEqual({ kind: 'figure', number: '5' });
  });
});
