import { describe, expect, it } from 'vitest';
import { matchObjects } from '../src/align/objects';
import type { DocModel, DocObject } from '../src/extract/types';
import type { Alignment } from '../src/align/align';

const fig = (id: number, number: string, caption: string, page: number): DocObject => ({
  id,
  kind: 'figure',
  number,
  page,
  box: [0, 0, 100, 100],
  parts: [[0, 0, 100, 100]],
  hashes: [''],
  caption,
  lines: [],
});

const doc = (objects: DocObject[]): DocModel => ({ objects, lines: [], numPages: 20, sections: [] }) as unknown as DocModel;

// No aligned text at all: pairing falls back to captions, numbers and the user's choices.
const noAlign = { tokensA: [], tokensB: [], aToB: new Int32Array(0), bToA: new Int32Array(0), aState: new Uint8Array(0), bState: new Uint8Array(0), aChange: new Int32Array(0), bChange: new Int32Array(0), changes: [] } as unknown as Alignment;

describe('matchObjects overrides', () => {
  const A = doc([fig(0, '1', 'Distribution of the alpha mass in simulated events with fit overlaid', 3), fig(1, '2', 'Efficiency of the selection as a function of beta momentum', 5)]);
  const B = doc([fig(0, '1', 'Efficiency of the selection as a function of beta momentum, new binning', 3), fig(1, '2', 'Distribution of the alpha mass in simulated events with fit overlaid', 5)]);
  const pairs = (ov = [] as Parameters<typeof matchObjects>[3]) => matchObjects(A, B, noAlign, ov).filter((m) => m.a !== null || m.b !== null).map((m) => [m.a, m.b]);

  it('pairs by caption wording when nothing is overridden', () => {
    expect(pairs()).toContainEqual([0, 1]);
    expect(pairs()).toContainEqual([1, 0]);
  });

  it('follows a pairing chosen by the user', () => {
    const p = pairs([{ kind: 'figure', a: '1', b: '1' }]);
    expect(p).toContainEqual([0, 0]);
    expect(p).not.toContainEqual([0, 1]);
  });

  it('leaves an object without counterpart when asked to', () => {
    const m = matchObjects(A, B, noAlign, [{ kind: 'figure', a: '1', b: null }]);
    expect(m.find((x) => x.a === 0)?.b).toBeNull();
    expect(m.find((x) => x.a === 0)?.status).toBe('removed');
  });
});
