import type { Alignment } from '../align/align';
import type { DocModel } from '../extract/types';
import type { Mark } from '../ui/marks';

export interface ExportSide {
  label: string;
  name: string;
  bytes: ArrayBuffer;
  doc: DocModel;
  /** Highlights to draw, per page (same rectangles as in the viewer). */
  marks: Map<number, Mark[]>;
}

/** One line of the change list on the summary pages. */
export interface SummaryItem {
  badge: string;
  /** Colour key, as the mark classes: del, ins, edit, num, mv, ren, toc, fig, cmt. */
  tone: string;
  pages: string;
  text: string;
  /** Page to link to (new version preferred). */
  bPage: number | null;
  aPage: number | null;
  section: string;
}

export interface ExportInput {
  title: string;
  A: ExportSide;
  B: ExportSide;
  al: Alignment;
  items: SummaryItem[];
  /** Extra list for review comments (only when included). */
  comments: SummaryItem[];
  appUrl: string;
}
