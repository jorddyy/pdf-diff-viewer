// Show how a figure of the old version is matched: npx tsx scripts/dev/debug-figure.ts old.pdf new.pdf 59
import { loadDoc } from '../node-pdf';
import { alignDocs } from '../../src/align/align';
import { matchObjects } from '../../src/align/objects';

const [fa, fb, num] = process.argv.slice(2);
const [{ doc: A }, { doc: B }] = await Promise.all([loadDoc(fa), loadDoc(fb)]);
const al = alignDocs(A, B);
const oa = A.objects.find((o) => o.kind === 'figure' && o.number === num)!;
console.log('old', oa.number, 'p', oa.page + 1, 'parts', oa.parts.length, 'hashes', oa.hashes, '\n  caption:', oa.caption.slice(0, 200), '\n  lines', oa.lines.map((l) => A.lines[l].kind));
const m = matchObjects(A, B, al).find((x) => x.a === oa.id);
console.log('match', m);
// Where do the caption tokens go?
const dest = new Map<string, number>();
al.tokensA.forEach((t, i) => {
  if (!oa.lines.includes(t.line)) return;
  const j = al.aToB[i];
  const k = j < 0 ? 'unmapped' : `${B.lines[al.tokensB[j].line].kind}/obj${B.lines[al.tokensB[j].line].object}/p${B.lines[al.tokensB[j].line].page + 1}`;
  dest.set(k, (dest.get(k) ?? 0) + 1);
});
console.log('caption tokens go to', dest);
for (const o of B.objects.filter((o) => o.kind === 'figure' && Math.abs(+o.number - +num) <= 5)) console.log('  new fig', o.number, 'p', o.page + 1, 'parts', o.parts.length, o.caption.slice(0, 90));
