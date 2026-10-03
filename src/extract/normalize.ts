// Text normalisation for comparison. Anything that differs between two builds
// of the same LaTeX source without a visible change should collapse here.

const REPLACEMENTS: [RegExp, string][] = [
  [/[−‐‑‒–—―]/g, '-'], // minus, hyphens, dashes
  [/[‘’‚‛′`´]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/­/g, ''], // soft hyphen
  [/[  -​  ]/g, ''],
  [/…/g, '...'],
];

export function normalizeToken(s: string): string {
  let t = s.normalize('NFKC');
  for (const [re, rep] of REPLACEMENTS) t = t.replace(re, rep);
  return t;
}

/** Private-use or replacement characters indicate glyphs without a usable Unicode mapping. */
export function isSuspiciousChar(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0xe000 && c <= 0xf8ff) || c === 0xfffd || (c >= 0xf0000 && c <= 0x10ffff);
}

/**
 * Hook for repairing broken text layers (e.g. browser re-prints that map
 * ligatures and minus signs to private-use code points). Currently a no-op;
 * a glyph-map learner or OCR fallback would slot in here.
 */
export function repairText(s: string): string {
  return s;
}

/** Bare reference-like number tokens: "12", "(13)", "[23]", "12," etc. */
export function stripPunct(s: string): string {
  return s.replace(/^[([{"']+|[)\]}"'.,;:]+$/g, '');
}

export function hasDigit(s: string): boolean {
  return /\d/.test(s);
}

/** Token skeleton with digits removed, used to detect "only numbers changed". */
export function digitSkeleton(s: string): string {
  return s.replace(/[\d.]+/g, '#');
}
