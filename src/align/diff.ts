// Sequence diff on interned token ids. Unique shingles anchor the two
// documents (patience style, robust against moved and repeated text); the gaps
// between anchors are diffed exactly with an LCS table, recursing on unique
// single tokens when a gap is too large for that.

export type OpType = 'equal' | 'delete' | 'insert';

export interface Op {
  type: OpType;
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

const MAX_CELLS = 3_000_000;

export function diffSeq(a: ArrayLike<number>, b: ArrayLike<number>): Op[] {
  const ops: Op[] = [];
  const anchors = shingleAnchors(a, b, 4);
  let ai = 0;
  let bi = 0;
  for (const [i, j, len] of anchors) {
    if (i < ai || j < bi) continue;
    diffRange(a, b, ai, i, bi, j, ops, 0);
    push(ops, 'equal', i, i + len, j, j + len);
    ai = i + len;
    bi = j + len;
  }
  diffRange(a, b, ai, a.length, bi, b.length, ops, 0);
  return ops;
}

function push(ops: Op[], type: OpType, a0: number, a1: number, b0: number, b1: number) {
  if (a1 === a0 && b1 === b0) return;
  const last = ops[ops.length - 1];
  if (last && last.type === type && last.a1 === a0 && last.b1 === b0) {
    last.a1 = a1;
    last.b1 = b1;
  } else ops.push({ type, a0, a1, b0, b1 });
}

/** Unique k-shingles shared by a and b, on the longest increasing chain, extended to maximal runs. */
function shingleAnchors(a: ArrayLike<number>, b: ArrayLike<number>, k: number): [number, number, number][] {
  const key = (s: ArrayLike<number>, i: number) => {
    let h = '';
    for (let t = 0; t < k; t++) h += s[i + t] + ',';
    return h;
  };
  const countA = new Map<string, number>();
  for (let i = 0; i + k <= a.length; i++) {
    const h = key(a, i);
    countA.set(h, countA.has(h) ? -1 : i);
  }
  const countB = new Map<string, number>();
  for (let j = 0; j + k <= b.length; j++) {
    const h = key(b, j);
    countB.set(h, countB.has(h) ? -1 : j);
  }
  const pairs: [number, number][] = [];
  for (const [h, i] of countA) {
    if (i < 0) continue;
    const j = countB.get(h);
    if (j !== undefined && j >= 0) pairs.push([i, j]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  const chain = longestIncreasing(pairs);

  // Merge overlapping shingles into runs and extend them as far as tokens agree.
  const runs: [number, number, number][] = [];
  for (const [i, j] of chain) {
    const last = runs[runs.length - 1];
    if (last && i - last[0] === j - last[1] && i <= last[0] + last[2]) {
      last[2] = Math.max(last[2], i + k - last[0]);
      continue;
    }
    if (last && (i < last[0] + last[2] || j < last[1] + last[2])) continue;
    runs.push([i, j, k]);
  }
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    const prev = runs[r - 1];
    const minA = prev ? prev[0] + prev[2] : 0;
    const minB = prev ? prev[1] + prev[2] : 0;
    while (run[0] > minA && run[1] > minB && a[run[0] - 1] === b[run[1] - 1]) {
      run[0]--;
      run[1]--;
      run[2]++;
    }
    const next = runs[r + 1];
    const maxA = next ? next[0] : a.length;
    const maxB = next ? next[1] : b.length;
    while (run[0] + run[2] < maxA && run[1] + run[2] < maxB && a[run[0] + run[2]] === b[run[1] + run[2]]) run[2]++;
  }
  return runs;
}

/** Longest chain of pairs increasing in both coordinates (pairs sorted by the first). */
function longestIncreasing(pairs: [number, number][]): [number, number][] {
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let p = 0; p < pairs.length; p++) {
    const j = pairs[p][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < j) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[p] = tails[lo - 1];
    tails[lo] = p;
  }
  const out: [number, number][] = [];
  for (let p = tails.length ? tails[tails.length - 1] : -1; p >= 0; p = prev[p]) out.push(pairs[p]);
  return out.reverse();
}

function diffRange(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  ops: Op[],
  depth: number,
): void {
  // Common prefix and suffix.
  let pre = 0;
  while (a0 + pre < a1 && b0 + pre < b1 && a[a0 + pre] === b[b0 + pre]) pre++;
  if (pre) push(ops, 'equal', a0, a0 + pre, b0, b0 + pre);
  a0 += pre;
  b0 += pre;
  let suf = 0;
  while (a1 - suf > a0 && b1 - suf > b0 && a[a1 - suf - 1] === b[b1 - suf - 1]) suf++;
  const ae = a1 - suf;
  const be = b1 - suf;

  const n = ae - a0;
  const m = be - b0;
  if (n === 0 || m === 0) {
    push(ops, 'delete', a0, ae, b0, b0);
    push(ops, 'insert', ae, ae, b0, be);
  } else if (n * m <= MAX_CELLS) {
    lcs(a, b, a0, ae, b0, be, ops);
  } else {
    const anchors = depth < 4 ? uniqueTokenAnchors(a, b, a0, ae, b0, be) : [];
    if (!anchors.length) {
      push(ops, 'delete', a0, ae, b0, b0);
      push(ops, 'insert', ae, ae, b0, be);
    } else {
      let ai = a0;
      let bi = b0;
      for (const [i, j] of anchors) {
        diffRange(a, b, ai, i, bi, j, ops, depth + 1);
        push(ops, 'equal', i, i + 1, j, j + 1);
        ai = i + 1;
        bi = j + 1;
      }
      diffRange(a, b, ai, ae, bi, be, ops, depth + 1);
    }
  }
  if (suf) push(ops, 'equal', ae, a1, be, b1);
}

function uniqueTokenAnchors(a: ArrayLike<number>, b: ArrayLike<number>, a0: number, a1: number, b0: number, b1: number): [number, number][] {
  const ca = new Map<number, number>();
  for (let i = a0; i < a1; i++) ca.set(a[i], ca.has(a[i]) ? -1 : i);
  const cb = new Map<number, number>();
  for (let j = b0; j < b1; j++) cb.set(b[j], cb.has(b[j]) ? -1 : j);
  const pairs: [number, number][] = [];
  for (const [t, i] of ca) {
    if (i < 0) continue;
    const j = cb.get(t);
    if (j !== undefined && j >= 0) pairs.push([i, j]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  return longestIncreasing(pairs);
}

function lcs(a: ArrayLike<number>, b: ArrayLike<number>, a0: number, a1: number, b0: number, b1: number, ops: Op[]): void {
  const n = a1 - a0;
  const m = b1 - b0;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[a0 + i] === b[b0 + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[a0 + i] === b[b0 + j]) {
      push(ops, 'equal', a0 + i, a0 + i + 1, b0 + j, b0 + j + 1);
      i++;
      j++;
    } else if (j >= m || (i < n && dp[(i + 1) * w + j] >= dp[i * w + j + 1])) {
      push(ops, 'delete', a0 + i, a0 + i + 1, b0 + j, b0 + j);
      i++;
    } else {
      push(ops, 'insert', a0 + i, a0 + i, b0 + j, b0 + j + 1);
      j++;
    }
  }
}
