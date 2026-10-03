// The standard PDF fonts only cover WinAnsi (Latin-1 plus a few signs);
// physics text is full of Greek letters and arrows. Spell those out.

const MAP: Record<string, string> = {
  '→': '->',
  '←': '<-',
  '↔': '<->',
  '⇒': '=>',
  '−': '-',
  '–': '-',
  '—': '-',
  '‐': '-',
  '±': '+/-',
  '∓': '-/+',
  '×': 'x',
  '·': '.',
  '≤': '<=',
  '≥': '>=',
  '≈': '~',
  '≠': '!=',
  '∝': '~',
  '∞': 'inf',
  '√': 'sqrt',
  '∫': 'int',
  '∑': 'sum',
  '…': '...',
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  'α': 'alpha',
  'β': 'beta',
  'γ': 'gamma',
  'Γ': 'Gamma',
  'δ': 'delta',
  'Δ': 'Delta',
  'ε': 'eps',
  'ζ': 'zeta',
  'η': 'eta',
  'θ': 'theta',
  'κ': 'kappa',
  'λ': 'lambda',
  'Λ': 'Lambda',
  'μ': 'mu',
  'ν': 'nu',
  'ξ': 'xi',
  'π': 'pi',
  'ρ': 'rho',
  'σ': 'sigma',
  'Σ': 'Sigma',
  'τ': 'tau',
  'φ': 'phi',
  'Φ': 'Phi',
  'χ': 'chi',
  'ψ': 'psi',
  'Ψ': 'Psi',
  'ω': 'omega',
  'Ω': 'Omega',
};

/** Make text writable with the standard fonts; anything else becomes "?". */
export function winAnsi(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFC')) {
    const code = ch.codePointAt(0)!;
    if (MAP[ch] !== undefined) out += MAP[ch];
    else if (code === 9 || code === 10) out += ' ';
    else if ((code >= 32 && code < 127) || (code >= 160 && code <= 255)) out += ch;
    else {
      const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      out += /^[\x20-\x7e]+$/.test(base) ? base : '?';
    }
  }
  return out;
}

/** Shorten to `max` characters with an ellipsis. */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}
