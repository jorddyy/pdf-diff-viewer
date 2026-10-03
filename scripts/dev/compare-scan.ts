// Compare figure/rule regions from the content-stream scanner with the pdf.js operator-list path.
import { loadDoc } from '../node-pdf';
const f = process.argv[2];
const { doc: a } = await loadDoc(f, true);
const { doc: b } = await loadDoc(f, false);
let diffPages = 0;
for (let p = 0; p < a.numPages; p++) {
  const ga = a.pages[p].graphics.map((r) => r.map((v) => Math.round(v)).join(',')).sort();
  const gb = b.pages[p].graphics.map((r) => r.map((v) => Math.round(v)).join(',')).sort();
  const ra = a.pages[p].rules.length, rb = b.pages[p].rules.length;
  if (b.pages[p].graphics.length === 0 && b.pages[p].rules.length === 0) continue; // pdf.js path skipped page
  if (ga.join('|') !== gb.join('|') || ra !== rb) { diffPages++; if (diffPages < 6) console.log('page', p + 1, 'scan', ga, ra, 'pdfjs', gb, rb); }
}
console.log('pages differing:', diffPages, 'lines', a.lines.length, b.lines.length);
