import { describe, expect, it } from 'vitest';
import { sameVersion, versionInName, versionKey, versionOnTitle } from '../src/extract/versionLabel';
import { workspaceTitle } from '../src/pdf/workspaces';

describe('version labels', () => {
  it('reads release suffixes in file names', () => {
    expect(versionInName('note-v4r1.pdf')).toBe('v4r1');
    expect(versionInName('note_V4R2.pdf')).toBe('v4r2');
    expect(versionInName('note-v3_5.pdf')).toBe('v3.5');
    expect(versionInName('note-v2.pdf')).toBe('v2');
    expect(versionInName('note-v2-review.pdf')).toBe('v2');
  });
  it('reads release suffixes on the title page', () => {
    expect(versionOnTitle('Version 4r1')).toBe('v4r1');
    expect(versionOnTitle('Draft v1.2')).toBe('v1.2');
    expect(versionOnTitle('version 3 released')).toBe('v3');
  });
  it('sorts and compares', () => {
    expect(versionKey('v4r2')).toEqual([4, 2]);
    expect(versionKey('v3.5.1')).toEqual([3, 5, 1]);
    expect(sameVersion('v4r1', 'v4.1')).toBe(true);
    expect(sameVersion('v1', 'v1.0.0')).toBe(true);
    expect(sameVersion('v4r1', 'v4r2')).toBe(false);
  });
  it('strips the release from the comparison title stem', () => {
    const vs = [
      { hash: 'a', name: 'note-v4r1.pdf', label: 'v4r1' },
      { hash: 'b', name: 'note-v4r2.pdf', label: 'v4r2' },
    ];
    expect(workspaceTitle(vs, 'a', 'b')).toBe('note · v4r1 → v4r2');
  });
});
