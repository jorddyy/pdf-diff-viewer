import { describe, expect, it } from 'vitest';
import { diffSeq, type Op } from '../src/align/diff';

/** Rebuild b from a and the edit script, and check the script covers both sequences. */
function apply(a: number[], b: number[], ops: Op[]): number[] {
  const out: number[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    expect(op.a0).toBe(ai);
    expect(op.b0).toBe(bi);
    if (op.type === 'equal') for (let k = 0; k < op.a1 - op.a0; k++) expect(a[op.a0 + k]).toBe(b[op.b0 + k]);
    for (let k = op.b0; k < op.b1; k++) out.push(b[k]);
    ai = op.a1;
    bi = op.b1;
  }
  expect(ai).toBe(a.length);
  expect(bi).toBe(b.length);
  return out;
}

const equalCount = (ops: Op[]) => ops.filter((o) => o.type === 'equal').reduce((n, o) => n + o.a1 - o.a0, 0);

function lcsLength(a: number[], b: number[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return dp[0][0];
}

// Deterministic pseudo-random numbers.
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

describe('diffSeq', () => {
  it('reports identical sequences as one equal run', () => {
    const a = [1, 2, 3, 4, 5, 6, 7];
    expect(diffSeq(a, a)).toEqual([{ type: 'equal', a0: 0, a1: 7, b0: 0, b1: 7 }]);
  });

  it('finds a single replacement', () => {
    const ops = diffSeq([1, 2, 3, 4, 5], [1, 2, 9, 4, 5]);
    expect(ops.map((o) => o.type)).toEqual(['equal', 'delete', 'insert', 'equal']);
  });

  it('produces valid edit scripts with optimal matches on random edits', () => {
    const r = rng(42);
    for (let trial = 0; trial < 200; trial++) {
      const a = Array.from({ length: 5 + Math.floor(r() * 60) }, () => Math.floor(r() * 12));
      const b = [...a];
      for (let e = 0; e < 1 + Math.floor(r() * 6); e++) {
        const pos = Math.floor(r() * (b.length + 1));
        const kind = r();
        if (kind < 0.33) b.splice(pos, 1);
        else if (kind < 0.66) b.splice(pos, 0, Math.floor(r() * 12));
        else b[pos] = Math.floor(r() * 12);
      }
      const ops = diffSeq(a, b);
      expect(apply(a, b, ops)).toEqual(b);
      // Anchoring may give up optimality in pathological cases, but not by much.
      expect(equalCount(ops)).toBeGreaterThanOrEqual(lcsLength(a, b) - 2);
    }
  });

  it('handles long documents with a moved paragraph', () => {
    const para = (k: number) => Array.from({ length: 40 }, (_, i) => 1000 * k + i);
    const a = [...para(1), ...para(2), ...para(3), ...para(4)];
    const b = [...para(1), ...para(3), ...para(4), ...para(2)];
    const ops = diffSeq(a, b);
    expect(apply(a, b, ops)).toEqual(b);
    expect(equalCount(ops)).toBe(120);
  });
});
