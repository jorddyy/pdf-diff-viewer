// Find figures with given fingerprints: npx tsx scripts/dev/find-hash.ts file.pdf hash...
import { loadDoc } from '../node-pdf';
const [f, ...hashes] = process.argv.slice(2);
const { doc } = await loadDoc(f);
for (const o of doc.objects) o.hashes.forEach((h, i) => hashes.includes(h) && console.log(`${o.kind} ${o.number || '(uncaptioned)'} p${o.page + 1} part ${i}: ${o.caption.slice(0, 100)}`));
