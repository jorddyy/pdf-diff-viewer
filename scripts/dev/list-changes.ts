// List changes of one class: npx tsx scripts/dev/list-changes.ts old.pdf new.pdf renumber|numeric|text|toc [kind]
import { loadDoc } from '../node-pdf';
import { alignDocs } from '../../src/align/align';

const [fa, fb, cls, kind] = process.argv.slice(2);
const [{ doc: A }, { doc: B }] = await Promise.all([loadDoc(fa), loadDoc(fb)]);
const al = alignDocs(A, B);
const fmt = (segs: { text: string; changed: boolean }[]) => segs.map((s) => (s.changed ? `[${s.text}]` : s.text)).join(' ');
for (const c of al.changes.filter((c) => c.cls === cls && (!kind || c.kind === kind))) {
  console.log(`#${c.id} ${c.kind} p${c.aPage + 1}→p${c.bPage + 1} ${c.label}: ${fmt(c.aSegs).slice(0, 90)}  ⇒  ${fmt(c.bSegs).slice(0, 90)}`);
}
