// Resolve a Markdown review against a set of versions and print where each comment lands.
//   npx tsx scripts/dev/check-comments.ts review.md target.pdf v1.pdf v2.pdf ...
import fs from 'node:fs';
import { loadDoc } from '../node-pdf';
import { parseComments } from '../../src/comments/parse';
import { assignRounds } from '../../src/comments/assign';
import { resolveComment, type ResolveContext, type VersionData } from '../../src/comments/resolve';
import { alignDocs, type Alignment } from '../../src/align/align';
import { matchObjects, matchSections } from '../../src/align/objects';

const [mdFile, targetFile, ...files] = process.argv.slice(2);
const parsed = parseComments(fs.readFileSync(mdFile, 'utf8'));
const versions: VersionData[] = [];
for (const [i, f] of files.entries()) versions.push({ id: i, label: '', doc: (await loadDoc(f)).doc });
for (const v of versions) v.label = v.doc.label;
const target = versions.find((v) => files[v.id] === targetFile)!;
const rounds = assignRounds(parsed, versions);
console.log('round → version:', parsed.rounds.map((r, i) => `${r} → ${versions.find((v) => v.id === rounds[i])?.label ?? '—'}`).join(' | '));
const cache = new Map<string, Alignment>();
const align = (a: VersionData, b: VersionData) => {
  const k = `${a.id}:${b.id}`;
  if (!cache.has(k)) cache.set(k, alignDocs(a.doc, b.doc));
  return cache.get(k)!;
};
const ctx: ResolveContext = {
  versionOfRound: (r) => versions.find((v) => v.id === rounds[r]) ?? null,
  target,
  align,
  objects: (a, b) => matchObjects(a.doc, b.doc, align(a, b)),
  sections: (a, b) => matchSections(a.doc, b.doc, align(a, b)),
};
const only = process.env.ROUND ? +process.env.ROUND : null;
const counts: Record<string, number> = {};
for (const it of parsed.items) {
  if (it.notes || (only !== null && it.round !== only)) continue;
  const r = resolveComment(it, ctx);
  counts[r.status] = (counts[r.status] ?? 0) + 1;
  const refs = r.refs.map((x) => `${x.source?.label ?? '?'}→${x.target?.label ?? '?'}:${x.status}${x.note ? '(' + x.note + ')' : ''}`).join(' ');
  console.log(`#${it.id} r${it.round} ${r.status.padEnd(10)} ${refs.padEnd(48)} ${it.text.slice(0, 50).replace(/\n/g, ' ')}`);
}
console.log(counts);
