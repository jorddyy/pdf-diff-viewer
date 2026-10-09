import { beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from '@pdfme/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractDocument } from '../src/extract/document';
import { nodeInflate } from '../scripts/node-pdf';
import { alignDocs, type Segment } from '../src/align/align';
import { buildAnnotated, textChangeSpecs } from '../src/export/annotated';
import { buildSideBySide } from '../src/export/sideBySide';
import { sideMarks } from '../src/ui/marks';
import type { DocModel } from '../src/extract/types';

// Invented prose only. Build real PDFs so these tests cover extraction as well as alignment.
const garden = [
  'A quiet garden stands beside the village library.',
  'The wooden gate opens toward a narrow gravel path.',
  'The sample colour is amber.',
  'Visitors can rest beneath the tall chestnut tree.',
  'Several small birds gather near the shallow pond.',
  'The box contains 12 wooden blocks.',
  'Fresh herbs grow along the sheltered southern wall.',
  'The caretaker waters the seedlings every morning.',
  'See Figure 2 for the arrangement of the flower beds.',
  'At sunset the gardener carefully closes the gate.',
  'A stone bench faces the old apple orchard.',
  'Rainwater collects in a barrel behind the shed.',
  'Climbing roses cover the arch beside the entrance.',
  'The vegetable patch supplies the village kitchen.',
  'Butterflies visit the lavender throughout the summer.',
  'A winding hedge separates the lawn from the road.',
];
const workshop = [
  'Inside the workshop a carpenter shapes a cedar shelf.',
  'Brass hinges wait beside polished handles on the workbench.',
  'A careful apprentice measures each plank before cutting.',
  'Finished cabinets dry slowly under a linen covering.',
];
const harbour = [
  'Beyond the harbour a lighthouse marks the rocky shoreline.',
  'Fishing boats return through calm water before breakfast.',
  'Dockworkers carefully unload baskets filled with fresh catch.',
  'A ferry captain checks the weather before departing.',
];

async function makePdf(pages: string[][], firstLine = 1, wrap = 100): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let line = firstLine;
  for (const paragraphs of pages) {
    const page = pdf.addPage([595, 842]);
    let y = 735;
    for (const paragraph of paragraphs) {
      const rows: string[] = [];
      let row = '';
      for (const word of paragraph.split(' ')) {
        if (row && row.length + word.length + 1 > wrap) { rows.push(row); row = ''; }
        row += (row ? ' ' : '') + word;
      }
      rows.push(row);
      for (const text of rows) {
        page.drawText(String(line++), { x: 30, y, size: 8, font });
        page.drawText(text, { x: 65, y, size: 11, font });
        y -= 18;
      }
    }
  }
  return new Uint8Array(await pdf.save()).buffer;
}

const open = (bytes: ArrayBuffer) => pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), verbosity: 0 }).promise;
async function extract(bytes: ArrayBuffer): Promise<DocModel> {
  const pdf = await open(bytes);
  try {
    return await extractDocument(pdf, pdfjs.OPS, 'synthetic.pdf', { bytes: new Uint8Array(bytes), inflate: nodeInflate });
  } finally {
    await pdf.loadingTask.destroy();
  }
}
const changed = (segments: Segment[]) => segments.filter((s) => s.changed).map((s) => s.text).join(' ');
const pageText = async (pdf: Awaited<ReturnType<typeof open>>, page: number) =>
  (await (await pdf.getPage(page)).getTextContent()).items.flatMap((item) => 'str' in item ? [item.str] : []).join(' ');

let oldBytes: ArrayBuffer;
let newBytes: ArrayBuffer;
let A: DocModel;
let B: DocModel;
beforeAll(async () => {
  oldBytes = await makePdf([garden]);
  newBytes = await makePdf([garden.map((line) => line.replace('amber', 'cobalt').replace('12 wooden', '18 wooden'))]);
  [A, B] = await Promise.all([extract(oldBytes), extract(newBytes)]);
});

describe('synthetic PDF accuracy', () => {
  it('reports exactly the planted text and number changes', () => {
    expect(A.hasLineNumbers).toBe(true);
    expect(alignDocs(A, B).changes.map((c) => ({
      kind: c.kind, cls: c.cls, before: changed(c.aSegs), after: changed(c.bSegs),
    }))).toEqual([
      { kind: 'replace', cls: 'text', before: 'amber.', after: 'cobalt.' },
      { kind: 'replace', cls: 'numeric', before: '12', after: '18' },
    ]);
  });

  it('ignores changed line numbers and line wrapping', async () => {
    const reflowed = await extract(await makePdf([garden], 40, 38));
    expect(reflowed.hasLineNumbers).toBe(true);
    expect(reflowed.lines.length).toBeGreaterThan(A.lines.length);
    expect(alignDocs(A, reflowed).changes).toEqual([]);
  });

  it('distinguishes a changed figure reference from a changed result', async () => {
    const renumbered = await extract(await makePdf([garden.map((line) => line.replace('Figure 2', 'Figure 3'))]));
    const changes = alignDocs(A, renumbered).changes;
    expect(changes).toHaveLength(1);
    expect(changes[0].cls).toBe('renumber');
    expect(changed(changes[0].aSegs)).toBe('2');
    expect(changed(changes[0].bSegs)).toBe('3');
  });

  it('reports a reordered paragraph once, without additions or deletions', async () => {
    const old = await extract(await makePdf([[...garden, ...workshop, ...harbour]]));
    const next = await extract(await makePdf([[...garden, ...harbour, ...workshop]]));
    const changes = alignDocs(old, next).changes;
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('moved');
    expect(changes[0].move!.words).toBeGreaterThan(20);
  });

  it('reports only the removed page content when later pages shift', async () => {
    const old = await extract(await makePdf([garden, workshop, harbour]));
    const next = await extract(await makePdf([garden, harbour]));
    const changes = alignDocs(old, next).changes;
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('delete');
    expect(changes[0].aPage).toBe(1);
    expect(changed(changes[0].aSegs)).toBe(workshop.join(' '));
  });
});

describe('exported PDF round trips', () => {
  it('preserves text and writes highlights over the changed words with the old values', async () => {
    const al = alignDocs(A, B);
    const bytes = await buildAnnotated(newBytes, B, textChangeSpecs(B, al, al.changes), 'Synthetic comparison');
    const pdf = await open(new Uint8Array(bytes).buffer);
    try {
      expect(pdf.numPages).toBe(1);
      expect(await pageText(pdf, 1)).toContain('The sample colour is cobalt.');
      const annotations = await (await pdf.getPage(1)).getAnnotations();
      expect(annotations.map((a) => [a.subtype, a.contentsObj.str])).toEqual([
        ['Highlight', 'Changed. Was: “amber.”'],
        ['Highlight', 'Number changed. Was: “12”'],
      ]);
      for (const [i, value] of ['cobalt.', '18'].entries()) {
        const word = B.words.find((w) => w.text === value)!;
        expect(word).toBeDefined();
        const [x0, y0, x1, y1] = word.box;
        const expected = [x0, 842 - y1, x1, 842 - y0];
        annotations[i].rect.forEach((n: number, j: number) => expect(n).toBeCloseTo(expected[j], 3));
        expect(annotations[i].quadPoints).toHaveLength(8);
      }
    } finally { await pdf.loadingTask.destroy(); }
  });

  it('writes a deletion caret carrying the removed text', async () => {
    const nextBytes = await makePdf([garden.filter((_, i) => i !== 2)]);
    const next = await extract(nextBytes);
    const al = alignDocs(A, next);
    const bytes = await buildAnnotated(nextBytes, next, textChangeSpecs(next, al, al.changes), 'Synthetic deletion');
    const pdf = await open(new Uint8Array(bytes).buffer);
    try {
      const annotations = await (await pdf.getPage(1)).getAnnotations();
      expect(annotations).toHaveLength(1);
      expect(annotations[0].subtype).toBe('Caret');
      expect(annotations[0].contentsObj.str).toBe('Removed: “The sample colour is amber.”');
    } finally { await pdf.loadingTask.destroy(); }
  });

  it('keeps both original texts in side-by-side sheets and links the summary to them', async () => {
    const al = alignDocs(A, B);
    const bytes = await buildSideBySide({
      title: 'Synthetic comparison', appUrl: 'https://example.invalid/',
      A: { label: 'v1', name: 'synthetic.v1.pdf', bytes: oldBytes, doc: A, marks: sideMarks(A, al, 'a', () => true) },
      B: { label: 'v2', name: 'synthetic.v2.pdf', bytes: newBytes, doc: B, marks: sideMarks(B, al, 'b', () => true) },
      al, comments: [], items: al.changes.map((c) => ({
        badge: 'Changed', tone: 'edit', pages: 'p.1', text: `${changed(c.aSegs)} to ${changed(c.bSegs)}`,
        aPage: c.aPage, bPage: c.bPage, section: '',
      })),
    });
    const pdf = await open(new Uint8Array(bytes).buffer);
    try {
      expect(pdf.numPages).toBe(2);
      expect(await pageText(pdf, 1)).toContain('Changes (2)');
      const text = await pageText(pdf, 2);
      expect(text).toContain('The sample colour is amber.');
      expect(text).toContain('The sample colour is cobalt.');
      expect((await pdf.getPage(2)).getViewport({ scale: 1 }).width).toBe(1262);
      const links = await (await pdf.getPage(1)).getAnnotations();
      expect(links).toHaveLength(2);
      for (const link of links) {
        expect(link.subtype).toBe('Link');
        expect(await pdf.getPageIndex(link.dest[0])).toBe(1);
      }
    } finally { await pdf.loadingTask.destroy(); }
  });
});
