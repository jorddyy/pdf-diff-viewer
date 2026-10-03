import { describe, expect, it } from 'vitest';
import { parseComments } from '../src/comments/parse';
import { annotateMarkdown } from '../src/comments/export';
import type { CommentResolution } from '../src/comments/resolve';

describe('annotateMarkdown', () => {
  it('adds the new location after each reference', () => {
    const md = '## Round 1\n- L19: "to altered" -> "to be altered"\n- Figure 39: two columns\n';
    const parsed = parseComments(md);
    const res: CommentResolution[] = [
      {
        item: parsed.items[0],
        status: 'changed',
        refs: [{ ref: parsed.items[0].refs[0], source: null, target: { page: 3, boxes: [], lines: [26], label: 'L26' }, status: 'changed', note: '' }],
      },
      {
        item: parsed.items[1],
        status: 'unchanged',
        refs: [{ ref: parsed.items[1].refs[0], source: null, target: { page: 50, boxes: [], lines: [], label: 'Figure 55' }, status: 'unchanged', note: 'renumbered' }],
      },
    ];
    expect(annotateMarkdown(md, res, 'v1.1')).toBe('## Round 1\n- L19 [v1.1: L26, changed]: "to altered" -> "to be altered"\n- Figure 39 [v1.1: Figure 55, renumbered]: two columns\n');
  });
});
