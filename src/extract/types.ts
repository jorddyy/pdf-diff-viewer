// Document model shared by extraction, alignment and UI.
// Coordinates are PDF points in a top-left origin system (y grows downwards),
// i.e. the page viewport at scale 1.

export type Rect = [x0: number, y0: number, x1: number, y1: number];

/** A run of non-whitespace glyphs from one pdf.js text item. */
export interface Piece {
  text: string;
  x0: number;
  x1: number;
  base: number;
  size: number;
  top: number;
  bottom: number;
  /** Whitespace was emitted right before this piece in content-stream order. */
  spaceBefore: boolean;
}

export type LineKind =
  | 'body'
  | 'heading'
  | 'caption'
  | 'table'
  | 'equation'
  | 'toc'
  | 'header'
  | 'footer';

export interface Word {
  id: number;
  text: string;
  /** Normalised form used for comparison. */
  norm: string;
  page: number;
  box: Rect;
  line: number;
}

export interface Line {
  id: number;
  page: number;
  /** Printed line number (lineno package), if the document has them. */
  num: number | null;
  box: Rect;
  base: number;
  size: number;
  kind: LineKind;
  words: number[];
  text: string;
  /** Index into DocModel.sections of the section this line belongs to. */
  section: number;
  /** Index into DocModel.objects when the line is part of a caption/table/equation. */
  object: number;
}

export type ObjectKind = 'figure' | 'table' | 'equation';

/** A numbered float or display equation. */
export interface DocObject {
  id: number;
  kind: ObjectKind;
  /** "13", "A.3", or "" for un-captioned figures. */
  number: string;
  page: number;
  /** Union of all parts, including the caption. */
  box: Rect;
  /** Graphic regions (sub-figures) for figures; the body for tables/equations. */
  parts: Rect[];
  /** Fingerprints of the figure parts ('' when unknown). */
  hashes: string[];
  caption: string;
  /** Lines belonging to the object (caption, table rows, equation rows). */
  lines: number[];
}

export interface Section {
  id: number;
  number: string;
  title: string;
  level: number;
  page: number;
  y: number;
  line: number;
}

export interface PageInfo {
  width: number;
  height: number;
  /** Graphics regions found in the content stream (Form XObjects, images). */
  graphics: Rect[];
  /** Fingerprint per graphic ('' when unknown): equal fingerprints mean identical figures. */
  graphicHashes: string[];
  /** Thin horizontal rules (tables). */
  rules: Rect[];
}

export interface TextQuality {
  glyphs: number;
  /** Private-use or replacement characters: a sign of a broken text layer. */
  suspicious: number;
  ok: boolean;
}

export interface DocModel {
  name: string;
  label: string;
  numPages: number;
  pages: PageInfo[];
  words: Word[];
  lines: Line[];
  objects: DocObject[];
  sections: Section[];
  hasLineNumbers: boolean;
  bodyLeft: number;
  bodyRight: number;
  bodySize: number;
  quality: TextQuality;
}
