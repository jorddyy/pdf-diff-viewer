// Run extraction + alignment on local sample PDFs and print statistics.
//   npx tsx scripts/check-samples.ts old.pdf new.pdf [--list N]
import { loadDoc } from './node-pdf';
import { alignDocs } from '../src/align/align';

const args = process.argv.slice(2);
const listN = args.includes('--list') ? +args[args.indexOf('--list') + 1] : 25;
const [fa, fb] = args.filter((a) => a.endsWith('.pdf'));
const t0 = performance.now();
const [{ doc: A }, { doc: B }] = await Promise.all([loadDoc(fa), loadDoc(fb)]);
const t1 = performance.now();
const al = alignDocs(A, B);
const t2 = performance.now();
console.log(`${A.label} (${A.numPages}p, ${al.tokensA.length} tokens) → ${B.label} (${B.numPages}p, ${al.tokensB.length} tokens)`);
console.log(`extract ${((t1 - t0) / 1000).toFixed(1)} s, align ${((t2 - t1) / 1000).toFixed(2)} s`);
const by: Record<string, number> = {};
for (const c of al.changes) by[`${c.kind}/${c.cls}`] = (by[`${c.kind}/${c.cls}`] ?? 0) + 1;
console.log('changes', al.changes.length, by);
const eqA = al.aState.filter((s) => s === 0).length;
console.log(`equal tokens: ${eqA}/${al.tokensA.length} old (${((100 * eqA) / al.tokensA.length).toFixed(1)}%)`);
const fmt = (segs: { text: string; changed: boolean }[]) => segs.map((s) => (s.changed ? `[${s.text}]` : s.text)).join(' ');
const step = Math.max(1, Math.floor(al.changes.length / listN));
for (let i = 0; i < al.changes.length; i += step) {
  const c = al.changes[i];
  console.log(`#${c.id} ${c.kind}/${c.cls} p${c.aPage + 1}→p${c.bPage + 1} ${c.section.slice(0, 30)} ${c.label}`);
  console.log(`   - ${fmt(c.aSegs).slice(0, 160)}`);
  console.log(`   + ${fmt(c.bSegs).slice(0, 160)}`);
}

// Objects
const { matchObjects } = await import('../src/align/objects');
const objs = matchObjects(A, B, al);
const stat: Record<string, number> = {};
for (const m of objs) {
  const k = `${m.kind}:${m.kind === 'figure' ? m.status : m.a === null ? 'added' : m.b === null ? 'removed' : m.captionChanged ? 'changed' : 'same'}${m.renumbered ? '+renum' : ''}`;
  stat[k] = (stat[k] ?? 0) + 1;
}
console.log('objects', stat);
for (const m of objs.filter((m) => m.kind === 'figure' && m.status !== 'identical').slice(0, 12)) {
  const oa = m.a !== null ? A.objects[m.a] : null;
  const ob = m.b !== null ? B.objects[m.b] : null;
  console.log(`  fig ${oa?.number ?? '-'}→${ob?.number ?? '-'} ${m.status} parts ${m.parts.map((p) => `${p.a}/${p.b}${p.sameHash ? '=' : '≠'}`).join(' ')} score ${m.score.toFixed(2)}`);
}
