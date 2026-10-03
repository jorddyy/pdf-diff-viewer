import type { Rect } from './types';
import { IDENTITY, multiply, transformRect, type Matrix } from './geometry';

export interface OperatorListLike {
  fnArray: number[];
  argsArray: unknown[];
}

export type OpsTable = Record<string, number>;

/**
 * Walk a pdf.js operator list and collect the page-space boxes of top-level
 * Form XObjects and images (pdfTeX turns every \includegraphics into one of
 * these) and of thin horizontal rules (table lines).
 */
export function extractGraphics(
  ol: OperatorListLike,
  OPS: OpsTable,
  viewportTransform: Matrix,
): { graphics: Rect[]; rules: Rect[] } {
  const graphics: Rect[] = [];
  const rules: Rect[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  let formDepth = 0;
  const realForms: boolean[] = [];
  let annotDepth = 0;
  const toPage = (local: Rect, m: Matrix) => transformRect(multiply(m, viewportTransform), local);

  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    const args = ol.argsArray[i] as any;
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case OPS.transform:
        ctm = multiply(args as Matrix, ctm);
        break;
      case OPS.beginAnnotation:
        annotDepth++;
        break;
      case OPS.endAnnotation:
        annotDepth--;
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(ctm);
        const matrix = (args?.[0] ? Array.from(args[0] as ArrayLike<number>) : IDENTITY) as Matrix;
        ctm = multiply(matrix, ctm);
        // pdf.js wraps pages with a transparency group in a form without a
        // bounding box; that wrapper is not a figure and must not hide them.
        const real = !!args?.[1];
        if (real && formDepth === 0 && annotDepth === 0) {
          const b = Array.from(args[1] as ArrayLike<number>);
          addGraphic(toPage([b[0], b[1], b[2], b[3]], ctm));
        }
        realForms.push(real);
        if (real) formDepth++;
        break;
      }
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? IDENTITY;
        if (realForms.pop()) formDepth--;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintImageXObjectRepeat:
        if (formDepth === 0 && annotDepth === 0) addGraphic(toPage([0, 0, 1, 1], ctm));
        break;
      case OPS.constructPath: {
        if (formDepth > 0 || annotDepth > 0) break;
        const minMax = args?.[2] as ArrayLike<number> | undefined;
        if (!minMax || minMax.length < 4 || !Number.isFinite(minMax[0])) break;
        const r = toPage([minMax[0], minMax[1], minMax[2], minMax[3]], ctm);
        if (r[3] - r[1] <= 2 && r[2] - r[0] >= 20) rules.push(r);
        break;
      }
    }
  }
  return { graphics, rules };

  function addGraphic(r: Rect) {
    graphics.push(r);
  }
}
