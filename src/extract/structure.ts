import type { DocModel, DocObject, Line, Rect, Section } from './types';
import { unionAll, union, overlapX } from './geometry';
import { digitSkeleton, normalizeToken } from './normalize';

export interface OutlineEntry {
  title: string;
  level: number;
  page: number;
  /** Destination top in viewport coordinates, or null if unknown. */
  y: number | null;
}

const CAPTION_RE = /^(Figure|Fig\.|Table)\s+((?:[A-Z]\.?)?\d+(?:\.\d+)?)\s*([:.])/;
const EQNUM_RE = /^\(((?:[A-Z]\.)?\d+[a-z]?)\)[.,]?$/;
const SECNUM_RE = /^(?:[A-Z]|\d+)(?:\.\d+)*\.?$/;

/** Page headers, footers and page numbers: repeated text at the same height near the page edge. */
export function markHeadersFooters(doc: DocModel): void {
  const counts = new Map<string, Set<number>>();
  const key = (l: Line) => `${Math.round(l.base / 3)}|${digitSkeleton(l.text)}`;
  for (const l of doc.lines) {
    const k = key(l);
    if (!counts.has(k)) counts.set(k, new Set());
    counts.get(k)!.add(l.page);
  }
  const minPages = Math.max(3, Math.ceil(0.3 * doc.numPages));
  const byPage = groupByPage(doc);
  for (const lines of byPage) {
    if (!lines.length) continue;
    const h = doc.pages[lines[0].page].height;
    for (const l of lines) {
      if (l.num !== null) continue;
      const nearTop = l.box[3] < 0.12 * h;
      const nearBottom = l.box[1] > 0.85 * h;
      if (!nearTop && !nearBottom) continue;
      const repeated = (counts.get(key(l))?.size ?? 0) >= minPages;
      const pageNumber = nearBottom && /^([ivxlc]+|\d+)$/i.test(l.text.trim());
      if (repeated || pageNumber) l.kind = nearTop ? 'header' : 'footer';
    }
  }
}

/** Table of contents: dot leaders, plus the page-number lines around them. */
export function markToc(doc: DocModel): void {
  const leader = /(\.\s?){5,}/;
  const byPage = groupByPage(doc);
  for (const lines of byPage) {
    const leaders = lines.filter((l) => leader.test(l.text)).length;
    for (const l of lines) {
      if (l.kind !== 'body') continue;
      if (leader.test(l.text)) l.kind = 'toc';
      else if (leaders >= 5 && l.num === null && /\s\d+$/.test(l.text) && /^([A-Z]|\d+)(\.\d+)*\s/.test(l.text)) l.kind = 'toc';
    }
  }
}

/** Section headings from the PDF outline (hyperref bookmarks), with a font-size fallback. */
export function markSections(doc: DocModel, outline: OutlineEntry[]): void {
  const sections: Section[] = [];
  const byPage = groupByPage(doc);
  const used = new Set<number>();
  for (const o of outline) {
    const lines = byPage[o.page] ?? [];
    const want = squash(o.title).slice(0, 24);
    if (!want) continue;
    const cands = lines.filter(
      (l) =>
        !used.has(l.id) &&
        (l.kind === 'body' || l.kind === 'heading') &&
        (o.y === null || (l.base >= o.y - 4 && l.base <= o.y + 80)) &&
        squash(l.text).includes(want),
    );
    const line = cands[0];
    if (!line) continue;
    used.add(line.id);
    sections.push(makeSection(doc, sections.length, line, o.title, o.level));
  }
  if (!sections.length) {
    // No outline: numbered lines in a larger font.
    for (const l of doc.lines) {
      if (l.kind !== 'body' || l.size < 1.15 * doc.bodySize) continue;
      const m = /^((?:[A-Z]|\d+)(?:\.\d+)*)\s+(\S.*)$/.exec(l.text);
      if (!m) continue;
      sections.push(makeSection(doc, sections.length, l, m[2], m[1].split('.').length));
    }
  }
  sections.sort((a, b) => a.line - b.line);
  sections.forEach((s, i) => (s.id = i));
  doc.sections = sections;
  let cur = -1;
  let si = 0;
  for (const l of doc.lines) {
    while (si < sections.length && sections[si].line <= l.id) cur = si++;
    l.section = cur;
  }
}

function makeSection(doc: DocModel, id: number, line: Line, title: string, level: number): Section {
  line.kind = 'heading';
  const first = doc.words[line.words[0]]?.text ?? '';
  const number = SECNUM_RE.test(first) && !squash(title).startsWith(squash(first)) ? first.replace(/\.$/, '') : '';
  return { id, number, title, level, page: line.page, y: line.box[1], line: line.id };
}

/** Captions, figures (graphics grouped under their caption), tables and numbered equations. */
export function markObjects(doc: DocModel): void {
  const objects: DocObject[] = [];
  const byPage = groupByPage(doc);
  for (let page = 0; page < byPage.length; page++) {
    const lines = byPage[page];
    const pageInfo = doc.pages[page];
    const captions: { obj: DocObject; first: Line; lines: Line[] }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.kind !== 'body') continue;
      if (doc.hasLineNumbers && l.num !== null) continue; // a sentence starting with "Table 3."
      const near = (r: Rect) => r[1] - 60 <= l.box[3] && r[3] + 60 >= l.box[1];
      const m = captionStart(normalizeToken(l.text), l.size < 0.97 * doc.bodySize, pageInfo.graphics.some(near) || pageInfo.rules.some(near));
      if (!m) continue;
      const capLines = [l];
      for (let j = i + 1; j < lines.length; j++) {
        const n = lines[j];
        const prev = capLines[capLines.length - 1];
        if (n.kind !== 'body' || (doc.hasLineNumbers && n.num !== null)) break;
        if (CAPTION_RE.test(normalizeToken(n.text))) break;
        if (n.base - prev.base > 1.6 * Math.max(prev.size, n.size)) break;
        capLines.push(n);
      }
      i += capLines.length - 1;
      const kind = m.kind;
      const obj: DocObject = {
        id: -1,
        kind,
        number: m.number,
        page,
        box: unionAll(capLines.map((c) => c.box))!,
        parts: [],
        hashes: [],
        caption: capLines.map((c) => c.text).join(' '),
        lines: capLines.map((c) => c.id),
      };
      for (const c of capLines) c.kind = 'caption';
      captions.push({ obj, first: l, lines: capLines });
    }

    // Figures: each graphic goes to the nearest figure caption below it
    // (LaTeX convention), else the nearest one above.
    const figCaps = captions.filter((c) => c.obj.kind === 'figure');
    const orphanGraphics: Rect[] = [];
    pageInfo.graphics.forEach((g, gi) => {
      const below = figCaps.filter((c) => c.obj.box[1] >= g[3] - 6).sort((a, b) => a.obj.box[1] - b.obj.box[1]);
      const above = figCaps.filter((c) => c.obj.box[3] <= g[1] + 6).sort((a, b) => b.obj.box[3] - a.obj.box[3]);
      const target = below[0] ?? above[0];
      if (target) {
        target.obj.parts.push(g);
        target.obj.hashes.push(pageInfo.graphicHashes[gi] ?? '');
      } else orphanGraphics.push(g);
    });
    for (const c of figCaps) {
      // Reading order of sub-figures: rows top to bottom, then left to right.
      const order = c.obj.parts.map((_, i) => i).sort((i, j) => {
        const a = c.obj.parts[i];
        const b = c.obj.parts[j];
        return Math.abs(a[1] - b[1]) > 10 ? a[1] - b[1] : a[0] - b[0];
      });
      c.obj.parts = order.map((i) => c.obj.parts[i]);
      c.obj.hashes = order.map((i) => c.obj.hashes[i]);
    }
    for (const c of figCaps) {
      if (!c.obj.parts.length) continue;
      const gBox = unionAll(c.obj.parts)!;
      // Sub-figure labels like "(a) Run 1" between the graphics and the caption.
      for (const l of lines) {
        if (l.kind !== 'body' || (doc.hasLineNumbers && l.num !== null)) continue;
        const inBand = l.base > gBox[1] && l.box[1] < c.obj.box[1] && overlapX(l.box, gBox) > 0;
        if (inBand && l.box[3] <= c.obj.box[1] + 1) {
          l.kind = 'caption';
          c.obj.lines.push(l.id);
        }
      }
      c.obj.box = union(c.obj.box, gBox);
    }
    // Graphics without a caption on this page (logos, continued floats).
    for (const g of mergeNearby(orphanGraphics)) {
      objects.push({ id: -1, kind: 'figure', number: '', page, box: g, parts: [g], hashes: [''], caption: '', lines: [] });
    }

    // Tables: rows between the caption and the end of the nearby rule cluster.
    for (const c of captions.filter((x) => x.obj.kind === 'table')) {
      const capBottom = c.obj.box[3];
      const capTop = c.obj.box[1];
      const otherCaps = captions.filter((x) => x !== c).map((x) => x.obj.box);
      const rulesBelow = pageInfo.rules.filter((r) => r[1] >= capBottom - 2 && !otherCaps.some((b) => b[1] > capBottom && b[1] < r[1]));
      const rulesAbove = pageInfo.rules.filter((r) => r[3] <= capTop + 2 && !otherCaps.some((b) => b[3] < capTop && b[3] > r[3]));
      let region: [number, number] | null = null;
      const cluster = (rs: Rect[], down: boolean) => {
        const ys = rs.map((r) => (r[1] + r[3]) / 2).sort((a, b) => (down ? a - b : b - a));
        if (!ys.length) return null;
        let last = ys[0];
        if (Math.abs(last - (down ? capBottom : capTop)) > 120) return null;
        for (const y of ys.slice(1)) {
          if (Math.abs(y - last) > 250) break;
          last = y;
        }
        return last;
      };
      const endBelow = cluster(rulesBelow, true);
      if (endBelow !== null) region = [capBottom, endBelow + 1];
      else {
        const endAbove = cluster(rulesAbove, false);
        if (endAbove !== null) region = [endAbove - 1, capTop];
      }
      const rows: Line[] = [];
      if (region) {
        for (const l of lines) if (l.kind === 'body' && l.base > region[0] && l.box[1] < region[1] && !(doc.hasLineNumbers && l.num !== null)) rows.push(l);
      } else if (doc.hasLineNumbers) {
        const start = lines.indexOf(c.lines[c.lines.length - 1]) + 1;
        for (let j = start; j < lines.length && lines[j].num === null && lines[j].kind === 'body'; j++) rows.push(lines[j]);
      }
      for (const r of rows) {
        r.kind = 'table';
        c.obj.lines.push(r.id);
        c.obj.parts.push(r.box);
      }
      if (rows.length) c.obj.box = union(c.obj.box, unionAll(rows.map((r) => r.box))!);
      if (region) {
        const ruleBox = unionAll(pageInfo.rules.filter((r) => r[1] >= region![0] - 2 && r[3] <= region![1] + 2));
        if (ruleBox) c.obj.box = union(c.obj.box, ruleBox);
      }
    }

    for (const c of captions) objects.push(c.obj);

    // Numbered display equations: "(13)" flush right, outside running text.
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.kind !== 'body' || (doc.hasLineNumbers && l.num !== null)) continue;
      const last = doc.words[l.words[l.words.length - 1]];
      if (!last || last.box[2] < doc.bodyRight - 8) continue;
      const m = EQNUM_RE.exec(normalizeToken(last.text));
      if (!m) continue;
      const rows = [l];
      const isDisplay = (n: Line) =>
        n.kind === 'body' && !(doc.hasLineNumbers && n.num !== null) && n.box[0] > doc.bodyLeft + 15 && !isNumberedEq(doc, n);
      for (let j = i - 1; j >= 0 && isDisplay(lines[j]) && rows[0].base - lines[j].base < 1.8 * doc.bodySize; j--) rows.unshift(lines[j]);
      for (let j = i + 1; j < lines.length && isDisplay(lines[j]) && lines[j].base - rows[rows.length - 1].base < 1.8 * doc.bodySize; j++) rows.push(lines[j]);
      const box = unionAll(rows.map((r) => r.box))!;
      for (const r of rows) r.kind = 'equation';
      objects.push({ id: -1, kind: 'equation', number: m[1], page, box, parts: [box], hashes: [''], caption: rows.map((r) => r.text).join(' '), lines: rows.map((r) => r.id) });
    }
  }

  objects.sort((a, b) => a.page - b.page || a.box[1] - b.box[1]);
  objects.forEach((o, i) => {
    o.id = i;
    for (const lid of o.lines) doc.lines[lid].object = i;
  });
  doc.objects = objects;
}

/**
 * Recognise a float caption at the start of a line. "Fig. 23." can also be
 * the end of a sentence that wrapped onto a new line, so without a colon we
 * require caption text after the label and either a caption font (smaller
 * than the body) or a graphic or rule close by.
 */
export function captionStart(text: string, smallFont: boolean, nearGraphics: boolean): { kind: 'figure' | 'table'; number: string } | null {
  const m = CAPTION_RE.exec(text);
  if (!m) return null;
  if (m[3] === '.') {
    const words = text.slice(m[0].length).trim().split(/\s+/).filter(Boolean).length;
    if (words < 4 || (!smallFont && !nearGraphics)) return null;
  }
  return { kind: m[1] === 'Table' ? 'table' : 'figure', number: m[2] };
}

function isNumberedEq(doc: DocModel, l: Line): boolean {
  const last = doc.words[l.words[l.words.length - 1]];
  return !!last && last.box[2] >= doc.bodyRight - 8 && EQNUM_RE.test(normalizeToken(last.text));
}

function mergeNearby(rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of rects) {
    const hit = out.findIndex((o) => !(r[0] > o[2] + 10 || r[2] < o[0] - 10 || r[1] > o[3] + 10 || r[3] < o[1] - 10));
    if (hit >= 0) out[hit] = union(out[hit], r);
    else out.push([...r] as Rect);
  }
  return out;
}

export function groupByPage(doc: DocModel): Line[][] {
  const byPage: Line[][] = Array.from({ length: doc.numPages }, () => []);
  for (const l of doc.lines) byPage[l.page].push(l);
  return byPage;
}

function squash(s: string): string {
  return normalizeToken(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}
