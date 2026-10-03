// Node helpers for running the pipeline outside the browser (scripts and tests).
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { extractDocument } from '../src/extract/document';
import type { DocModel } from '../src/extract/types';

export async function openPdf(file: string): Promise<PDFDocumentProxy> {
  const data = new Uint8Array(fs.readFileSync(file));
  return (await pdfjs.getDocument({ data, verbosity: 0 }).promise) as unknown as PDFDocumentProxy;
}

export const nodeInflate = async (data: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }));

export async function loadDoc(file: string, scan = true): Promise<{ pdf: PDFDocumentProxy; doc: DocModel }> {
  const pdf = await openPdf(file);
  const bytes = scan ? new Uint8Array(fs.readFileSync(file)) : undefined;
  const doc = await extractDocument(pdf, pdfjs.OPS as any, path.basename(file), { bytes, inflate: nodeInflate });
  return { pdf, doc };
}
