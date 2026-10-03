// Print what extraction found in one PDF: npx tsx scripts/inspect.ts file.pdf [page]
import { loadDoc } from './node-pdf';

const [file, pageArg] = process.argv.slice(2);
const t0 = performance.now();
const { doc } = await loadDoc(file);
console.log(`${doc.name} → ${doc.label}: ${doc.numPages} pages, ${doc.lines.length} lines, ${doc.words.length} words in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
console.log(`body size ${doc.bodySize}, left ${doc.bodyLeft}, right ${doc.bodyRight}, line numbers: ${doc.hasLineNumbers}, text quality ok: ${doc.quality.ok} (${doc.quality.suspicious}/${doc.quality.glyphs})`);
const kinds: Record<string, number> = {};
for (const l of doc.lines) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
console.log('line kinds', kinds);
const objs: Record<string, number> = {};
for (const o of doc.objects) objs[o.kind + (o.number ? '' : '(uncaptioned)')] = (objs[o.kind + (o.number ? '' : '(uncaptioned)')] ?? 0) + 1;
console.log('objects', objs);
console.log('sections', doc.sections.length, doc.sections.slice(0, 12).map((s) => `${s.number} ${s.title} (p${s.page + 1})`).join(' | '));
const numbered = doc.lines.filter((l) => l.num !== null);
if (numbered.length) {
  let breaks = 0;
  for (let i = 1; i < numbered.length; i++) if (numbered[i].num !== numbered[i - 1].num! + 1) breaks++;
  console.log(`numbered lines ${numbered.length}: ${numbered[0].num}..${numbered[numbered.length - 1].num}, non-consecutive steps ${breaks}`);
}
if (pageArg) {
  const p = +pageArg - 1;
  for (const l of doc.lines.filter((x) => x.page === p)) console.log(`${String(l.num ?? '').padStart(4)} ${l.kind.padEnd(8)} ${l.object >= 0 ? `[${doc.objects[l.object].kind} ${doc.objects[l.object].number}]` : ''} ${l.text.slice(0, 100)}`);
  for (const o of doc.objects.filter((x) => x.page === p)) console.log(`  obj ${o.kind} ${o.number} parts=${o.parts.length} box=${o.box.map((v) => v.toFixed(0)).join(',')} :: ${o.caption.slice(0, 80)}`);
}
