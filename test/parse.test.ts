import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { parseComments, findRefs, findSnippets, type CommentRef } from '../src/comments/parse';

const md = fs.readFileSync(new URL('./fixtures/review.md', import.meta.url), 'utf8');
const parsed = parseComments(md);
const short = (r: CommentRef) => (r.kind === 'line' ? `L${r.from}${r.to !== r.from ? '-' + r.to : ''}` : `${r.kind}:${r.ids.join('/')}`);
const refsOf = (needle: string) => parsed.items.find((i) => i.text.includes(needle) || i.quoted.includes(needle))!.refs.map(short);

describe('parseComments', () => {
  it('finds rounds and skips letters and reader lists', () => {
    expect(parsed.rounds).toEqual(['Round 1 comments', 'Round 2 comments']);
    expect(parsed.items.some((i) => i.text.includes('Someone'))).toBe(false);
    expect(parsed.items.some((i) => i.text.includes('Dear proponents'))).toBe(false);
  });

  it('parses line references in all their forms', () => {
    expect(refsOf('"teh"')).toEqual(['L12']);
    expect(refsOf('rephrase')).toEqual(['L8-9']);
    expect(refsOf('constraint is applied')).toEqual(['L595-597']);
    expect(refsOf('list all inputs')).toEqual(['L760-761']);
    expect(refsOf('state the size')).toEqual(['L107', 'L1274-1275']);
    expect(refsOf('L0 trigger')).toEqual([]);
  });

  it('parses figures, tables, equations, sections and citations', () => {
    expect(refsOf('add a legend')).toEqual(['figure:2', 'figure:24']);
    expect(refsOf('pulls look fine')).toEqual(['figure:39/40']);
    expect(refsOf('white areas')).toEqual(['figure:52/53']);
    expect(refsOf('keep in Section 3')).toEqual(['table:9/10', 'section:3']);
    expect(refsOf('define f')).toEqual(['equation:12', 'equation:3', 'equation:13']);
    expect(refsOf('Sec 4.1')).toEqual(['section:4.1', 'section:5.2.4', 'section:F']);
    expect(refsOf('add the link')).toEqual(['cite:29', 'cite:11/12']);
    expect(refsOf('bigger please')).toEqual(['figure:103/104/105/106']);
    expect(refsOf('2 columns wide')).toEqual([]);
  });

  it('keeps section context and general comments', () => {
    const it = parsed.items.find((i) => i.text.includes('"teh"'))!;
    expect(it.section).toBe('Section 2');
    expect(it.round).toBe(0);
    expect(parsed.items.find((i) => i.text.includes('summary table'))?.refs).toEqual([]);
  });

  it('turns a quoted comment, reply and follow-up into one thread', () => {
    const t = parsed.items.find((i) => i.quoted.includes('purpose of the control sample'))!;
    expect(t.round).toBe(1);
    expect(t.reply).toContain('replaces missing simulation');
    expect(t.text).toContain('can you refer to this');
    expect(t.refs.map((r) => [short(r), r.round, r.now])).toEqual([
      ['L105', 0, false],
      ['L132-135', 1, true],
    ]);
  });

  it('flags notes to self', () => {
    expect(parsed.items.find((i) => i.text.includes('systematics again'))?.notes).toBe(true);
  });

  it('records absolute offsets of each reference', () => {
    for (const item of parsed.items) for (const r of item.refs) expect(md.slice(r.start, r.end)).toBe(r.text);
  });
});

describe('findRefs', () => {
  it('ignores numbers inside URLs', () => {
    expect(findRefs('see https://cds.example.org/record/1234567#Fig5 and L12', 0, 0).map((r) => r.text)).toEqual(['L12']);
  });
});

describe('findSnippets', () => {
  it('keeps the old text of an edit and drops the replacement', () => {
    expect(findSnippets('"combiantion" → "combination"')).toEqual(['combiantion']);
    expect(findSnippets("L5: 'to altered' -> 'to be altered'")).toEqual(['to altered']);
    expect(findSnippets("it's the authors' choice")).toEqual([]);
  });
});
