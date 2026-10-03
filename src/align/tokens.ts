import type { DocModel } from '../extract/types';

export interface Token {
  norm: string;
  /** Word ids (two for a word hyphenated across lines). */
  words: number[];
  line: number;
}

const COMPARED = new Set(['body', 'heading', 'caption', 'table', 'equation', 'toc']);

/** The comparison stream of a document: words in reading order, with end-of-line hyphenation undone. */
export function tokenize(doc: DocModel): Token[] {
  const tokens: Token[] = [];
  let pending: Token | null = null;
  for (const line of doc.lines) {
    if (!COMPARED.has(line.kind)) continue;
    line.words.forEach((wid, k) => {
      const w = doc.words[wid];
      if (pending && k === 0 && /^[a-z]/.test(w.norm)) {
        pending.norm = pending.norm.slice(0, -1) + w.norm;
        pending.words.push(wid);
        tokens.push(pending);
        pending = null;
        return;
      }
      if (pending) {
        tokens.push(pending);
        pending = null;
      }
      // Digit grouping with thin spaces ("497 052", siunitx) compares equal to "497052".
      const prev = tokens[tokens.length - 1];
      if (prev && prev.line === line.id && k > 0 && /^\d{3}([.,;:)]*)$/.test(w.norm) && /(^|[^\d.])\d{1,3}$/.test(prev.norm)) {
        const pw = doc.words[prev.words[prev.words.length - 1]];
        if (w.box[0] - pw.box[2] < 0.4 * (w.box[3] - w.box[1])) {
          prev.norm += w.norm;
          prev.words.push(wid);
          return;
        }
      }
      const tok: Token = { norm: w.norm, words: [wid], line: line.id };
      const last = k === line.words.length - 1;
      if (last && line.kind === 'body' && /[a-z]{2}-$/i.test(w.norm)) pending = tok;
      else tokens.push(tok);
    });
  }
  if (pending) tokens.push(pending);
  return tokens;
}

/** Map token strings to shared integer ids so both documents can be diffed as int arrays. */
export function intern(a: Token[], b: Token[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const conv = (ts: Token[]) => {
    const out = new Int32Array(ts.length);
    ts.forEach((t, i) => {
      let id = ids.get(t.norm);
      if (id === undefined) ids.set(t.norm, (id = ids.size));
      out[i] = id;
    });
    return out;
  };
  return [conv(a), conv(b)];
}
