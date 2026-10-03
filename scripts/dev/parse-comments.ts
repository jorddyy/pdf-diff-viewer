// Print what the comment parser finds: npx tsx scripts/dev/parse-comments.ts file.md
import fs from 'node:fs';
import { parseComments } from '../../src/comments/parse';

const md = fs.readFileSync(process.argv[2], 'utf8');
const { rounds, items } = parseComments(md);
console.log('rounds:', rounds);
for (const it of items) {
  const refs = it.refs.map((r) => (r.kind === 'line' ? `L${r.from}${r.to !== r.from ? '-' + r.to : ''}` : `${r.kind}:${r.ids.join('/')}`) + (r.round !== it.round ? `@r${r.round}` : '') + (r.now ? '(now)' : '')).join(' ');
  console.log(`#${it.id} r${it.round}${it.notes ? ' NOTE' : ''} [${it.section.slice(0, 18)}] {${refs}} ${it.snippets.length ? 'snip=' + JSON.stringify(it.snippets) : ''} :: ${(it.quoted ? '«' + it.quoted.slice(0, 30) + '» ' : '') + it.text.slice(0, 60).replace(/\n/g, ' ')}`);
}
