import type { DocModel } from '../extract/types';
import { normalizeToken } from '../extract/normalize';
import type { ParsedComments } from './parse';

export interface VersionDoc {
  id: number;
  doc: DocModel;
}

const fold = (s: string) => normalizeToken(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Guess which version each review round was written on (`versions` sorted
 * oldest first). Evidence: quoted text found on the line it is attributed to
 * (1 point) or within three lines (½ point). Rounds with clear evidence are
 * placed first; rounds without evidence are slotted in order between them,
 * or left unassigned when no loaded version fits (e.g. a round on a paper
 * draft that is not loaded). Returns a version id (or null) per round.
 */
export function assignRounds(parsed: ParsedComments, versions: VersionDoc[]): (number | null)[] {
  const text = new Map<number, Map<number, string>>();
  for (const v of versions) {
    if (!v.doc.hasLineNumbers) continue;
    const m = new Map<number, string>();
    for (const l of v.doc.lines) if (l.num !== null) m.set(l.num, fold(l.text));
    text.set(v.id, m);
  }

  const n = parsed.rounds.length;
  // undefined: no evidence; null: evidence that the version is not loaded.
  const strong: (number | null | undefined)[] = new Array(n).fill(undefined);
  for (let r = 0; r < n; r++) {
    const probes: { from: number; to: number; snip: string }[] = [];
    for (const it of parsed.items) {
      if (it.notes) continue;
      for (const ref of it.refs) {
        if (ref.kind !== 'line' || ref.round !== r || ref.now) continue;
        for (const s of it.snippets) if (fold(s).length >= 3) probes.push({ from: ref.from, to: ref.to, snip: fold(s) });
      }
    }
    if (!probes.length) continue;
    const scores = versions.map((v) => {
      const m = text.get(v.id);
      if (!m) return 0;
      let score = 0;
      for (const p of probes) {
        const at = (k: number) => (m.get(k) ?? '') + ' ' + (m.get(k + 1) ?? '');
        let exact = false;
        for (let k = p.from; k <= p.to && !exact; k++) exact = at(k).includes(p.snip);
        if (exact) score += 1;
        else {
          for (let k = p.from - 3; k <= p.to + 3; k++) {
            if (at(k).includes(p.snip)) {
              score += 0.5;
              break;
            }
          }
        }
      }
      return score;
    });
    const sorted = [...scores].sort((a, b) => b - a);
    const best = sorted[0] ?? 0;
    const second = sorted[1] ?? 0;
    if (best >= 1 && best > second && best >= 0.3 * probes.length) {
      // Among equal scores prefer the oldest.
      strong[r] = versions[scores.indexOf(best)].id;
    } else if (probes.length >= 2 && best < 0.25 * probes.length) {
      strong[r] = null;
    }
  }

  // Fill the rounds without evidence in order between their neighbours.
  const out: (number | null)[] = new Array(n).fill(null);
  const idx = (id: number | null | undefined) => (id === null || id === undefined ? -1 : versions.findIndex((v) => v.id === id));
  let r = 0;
  let lastIdx = -1;
  while (r < n) {
    if (strong[r] !== undefined) {
      out[r] = strong[r]!;
      if (strong[r] !== null) lastIdx = idx(strong[r]);
      r++;
      continue;
    }
    // A run of rounds without evidence: r .. e-1.
    let e = r;
    while (e < n && strong[e] === undefined) e++;
    const nextIdx = e < n && strong[e] !== null ? idx(strong[e]) : versions.length;
    let k = lastIdx + 1;
    for (let q = r; q < e; q++) {
      if (k < nextIdx) {
        out[q] = versions[k].id;
        lastIdx = k++;
      } else out[q] = null;
    }
    r = e;
  }
  return out;
}
