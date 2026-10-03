import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { PdfFile, scanPage } from '../src/pdf/scan';

const inflate = async (d: Uint8Array) => new Uint8Array(zlib.inflateSync(d));

/** Build a small PDF with a classic xref table: one page placing a form XObject and a table rule. */
function makePdf(compressContent: boolean): Uint8Array {
  const content = 'q 1 0 0 1 100 500 cm 0.5 0 0 0.5 0 0 cm /Fig1 Do Q BT /F1 12 Tf 72 700 Td (Hello) Tj ET 0.4 w 72 300 m 523 300 l S';
  const contentBytes = compressContent ? zlib.deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  const form = '0 0 m 400 300 l S';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Fig1 5 0 R >> >> /Contents 4 0 R >>',
    null, // content stream
    `<< /Type /XObject /Subtype /Form /BBox [0 0 400 300] /Length ${form.length} >>\nstream\n${form}\nendstream`,
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(pos);
    let buf: Buffer;
    if (o === null) {
      const head = `${i + 1} 0 obj\n<< /Length ${contentBytes.length}${compressContent ? ' /Filter /FlateDecode' : ''} >>\nstream\n`;
      buf = Buffer.concat([Buffer.from(head, 'latin1'), contentBytes, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    } else buf = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    parts.push(buf);
    pos += buf.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}

describe('content-stream scanner', () => {
  for (const compressed of [false, true]) {
    it(`finds XObject placements and rules (${compressed ? 'compressed' : 'plain'} content)`, async () => {
      const file = await PdfFile.open(makePdf(compressed), inflate);
      const pages = await file.pages();
      expect(pages.length).toBe(1);
      const res = await scanPage(file, pages[0]);
      expect(res.graphics.length).toBe(1);
      expect(res.graphics[0].kind).toBe('form');
      expect(res.graphics[0].rect).toEqual([100, 500, 300, 650]);
      expect(res.graphics[0].hash).toMatch(/^[0-9a-f]+$/);
      expect(res.rules).toEqual([[72, 300, 523, 300]]);
    });
  }

  it('gives identical figures the same fingerprint', async () => {
    const a = await PdfFile.open(makePdf(false), inflate);
    const b = await PdfFile.open(makePdf(true), inflate);
    const ga = (await scanPage(a, (await a.pages())[0])).graphics[0];
    const gb = (await scanPage(b, (await b.pages())[0])).graphics[0];
    expect(ga.hash).toBe(gb.hash);
  });

  it('recovers from a broken cross-reference table', async () => {
    const pdf = makePdf(false);
    const text = Buffer.from(pdf).toString('latin1').replace(/startxref\n\d+/, 'startxref\n999999');
    const file = await PdfFile.open(new Uint8Array(Buffer.from(text, 'latin1')), inflate);
    expect((await file.pages()).length).toBe(1);
  });
});
