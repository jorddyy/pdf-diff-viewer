import { useMemo } from 'preact/hooks';
import temml from 'temml';
import 'temml/dist/Temml-Local.css';

// $…$, $$…$$, \(…\) and \[…\]. A "$" next to a space or digit is money, not maths.
const MATH = /\$\$([^$]+?)\$\$|\$(?=\S)([^$\n]*?\S)\$(?!\d)|\\\((.+?)\\\)|\\\[(.+?)\\\]/gs;

function render(tex: string, display: boolean): string | null {
  try {
    return temml.renderToString(tex, { displayMode: display, throwOnError: true });
  } catch {
    return null;
  }
}

/** Text with LaTeX formulas typeset (MathML); formulas that do not parse stay as typed. */
export function Tex({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: (string | { html: string })[] = [];
    let last = 0;
    for (const m of text.matchAll(MATH)) {
      const tex = m[1] ?? m[2] ?? m[3] ?? m[4];
      const html = render(tex, m[1] !== undefined || m[4] !== undefined);
      if (html === null) continue;
      if (m.index! > last) out.push(text.slice(last, m.index));
      out.push({ html });
      last = m.index! + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }, [text]);
  if (parts.length === 1 && typeof parts[0] === 'string') return <>{parts[0]}</>;
  return <>{parts.map((p) => (typeof p === 'string' ? p : <span class="tex" dangerouslySetInnerHTML={{ __html: p.html }} />))}</>;
}
