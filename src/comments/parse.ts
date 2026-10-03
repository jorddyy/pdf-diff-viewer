// Parse a Markdown review (HackMD/CodiMD style) into individual comments with
// the references they make: line numbers, figures, tables, equations,
// sections and citations, plus quoted text that pins down the location.

export type RefKind = 'line' | 'figure' | 'table' | 'equation' | 'section' | 'cite';

export interface CommentRef {
  kind: RefKind;
  /** Line range for kind 'line'. */
  from: number;
  to: number;
  /** Object numbers ("12", "A.3") for the other kinds. */
  ids: string[];
  /** Offsets of the reference in the original Markdown. */
  start: number;
  end: number;
  text: string;
  /** Round the reference belongs to (a quoted earlier comment refers to an earlier version). */
  round: number;
  /** "(now L132-135)": already refers to the newer version. */
  now: boolean;
}

export interface CommentItem {
  id: number;
  /** Text of the comment (Markdown, without quote markers). */
  text: string;
  /** A quoted earlier comment this one follows up on. */
  quoted: string;
  /** Proponents' reply quoted in the thread. */
  reply: string;
  round: number;
  section: string;
  notes: boolean;
  refs: CommentRef[];
  /** Quoted text from the note, e.g. "combiantion" in `"combiantion" -> "combination"`. */
  snippets: string[];
  start: number;
  end: number;
  /** Whole source lines of the item, including a quoted comment and reply: [start, end). */
  span: [number, number];
  /** Stable identity (round + text), e.g. for "done" ticks. */
  key: string;
}

export interface ParsedComments {
  rounds: string[];
  items: CommentItem[];
}

interface SrcLine {
  text: string;
  start: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+/;
const QUOTE = /^\s*((?:>\s?)+)/;
const ROUND_HEADING = /round|comments?|review|replies|draft|follow/i;
const NOTES_HEADING = /notes?\s+to\s+self|^notes?$|^to\s*do|^check:?$/i;
const GENERAL_HEADING = /general/i;
const STARTS_WITH_REF =
  /^\s*(?:[-*+]\s+)?(?:\*\*)?(?:L\.?\s?\d|lines?\s+\d|\d{1,4}\s?[-–]\s?\d{1,4}\s*:|Fig(?:ure)?s?\.?\s?\d|Tab(?:le)?s?\.?\s?\d|Eq(?:uation)?s?\.?\s?\(?\d|Sec(?:tion)?s?\.?\s?[\dA-Z]|App(?:endix)?\.?\s?[A-Z]|Refs?\.?\s?\d)/i;

export function parseComments(md: string): ParsedComments {
  const lines: SrcLine[] = [];
  let off = 0;
  for (const text of md.split('\n')) {
    lines.push({ text, start: off });
    off += text.length + 1;
  }

  const rounds: string[] = [];
  const items: CommentItem[] = [];
  let round = -1;
  let roundLevel = 0;
  let section = '';
  let notes = false;
  let notesLevel = 99;
  let cur: { parts: SrcLine[]; quoted: SrcLine[]; reply: SrcLine[]; list: boolean; indent: number } | null = null;
  // The last quoted comment + reply, waiting for the reviewer's follow-up paragraph.
  let thread: { quoted: SrcLine[]; reply: SrcLine[] } | null = null;

  const flush = () => {
    if (!cur) return;
    const c = cur;
    cur = null;
    if (!c.parts.length && !c.quoted.length) return;
    const body = c.parts.map((l) => l.text).join('\n').trim();
    const refs = c.parts.flatMap((l) => findRefs(l.text, l.start, round));
    const quotedRefs = c.quoted.flatMap((l) => findRefs(l.text, l.start, Math.max(0, round - 1)));
    const isGeneral = GENERAL_HEADING.test(section);
    if (!c.list && !refs.length && !quotedRefs.length && !isGeneral && !c.quoted.length) return;
    // Lists before the first round (readers, links) are not comments unless they are review notes.
    if (round < 0 && !refs.length && !quotedRefs.length && !/review|comment|general/i.test(section)) return;
    if (!body && !c.quoted.length) return;
    const all = c.parts.length ? c.parts : c.quoted;
    const offsets = [...c.quoted, ...c.reply, ...c.parts].map((l) => [l.start, l.start + l.text.length]);
    const first = lineAt(Math.min(...offsets.map((o) => o[0])));
    const last = lineAt(Math.max(...offsets.map((o) => o[1])));
    items.push({
      id: items.length,
      text: stripMarkers(body),
      quoted: stripMarkers(c.quoted.map((l) => l.text.replace(QUOTE, '')).join('\n').trim()),
      reply: stripMarkers(c.reply.map((l) => l.text.replace(QUOTE, '')).join('\n').trim()),
      round,
      section,
      notes,
      // Refs of the quoted earlier comment come first; the follow-up's own refs refine them.
      refs: [...quotedRefs, ...refs],
      snippets: [...findSnippets(c.quoted.map((l) => l.text).join('\n')), ...findSnippets(body)],
      start: all[0].start,
      end: all[all.length - 1].start + all[all.length - 1].text.length,
      span: [first.start, Math.min(md.length, last.start + last.text.length + 1)],
      key: stableKey(`${round}|${body}|${c.quoted.map((l) => l.text).join('\n')}`),
    });
  };
  /** The source line containing an offset. */
  const lineAt = (offset: number): SrcLine => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid].start <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lines[lo];
  };

  for (const line of lines) {
    const t = line.text;
    const h = HEADING.exec(t);
    if (h) {
      flush();
      thread = null;
      const level = h[1].length;
      const title = h[2].replace(/[*_`]/g, '').replace(/:\s*$/, '').trim();
      if (level <= notesLevel) {
        notes = false;
        notesLevel = 99;
      }
      if (NOTES_HEADING.test(title)) {
        notes = true;
        notesLevel = level;
      } else if (level <= 2 && level > 1 && ROUND_HEADING.test(title)) {
        rounds.push(title);
        round = rounds.length - 1;
        roundLevel = level;
        section = '';
      } else if (level > roundLevel || roundLevel === 0) section = title;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(t) || /^\s*#{6}\s/.test(t)) {
      flush();
      thread = null;
      continue;
    }
    if (!t.trim()) {
      // A blank line ends a paragraph, but not a list item with indented continuation.
      if (cur && !cur.list) flush();
      continue;
    }
    const listMatch = LIST.exec(t);
    const withoutList = listMatch ? t.slice(listMatch[0].length) : t;
    const q = QUOTE.exec(withoutList);
    const depth = q ? (q[1].match(/>/g) ?? []).length : 0;

    if (depth >= 2) {
      // Start (or continue) a quoted earlier comment.
      if (!thread || thread.reply.length) {
        flush();
        thread = { quoted: [], reply: [] };
      }
      thread.quoted.push({ text: withoutList.replace(QUOTE, ''), start: line.start + (t.length - withoutList.replace(QUOTE, '').length) });
      continue;
    }
    if (depth === 1) {
      if (thread) thread.reply.push(line);
      continue;
    }
    // Plain text or list item.
    const indent = listMatch ? listMatch[1].length : (/^\s*/.exec(t)?.[0].length ?? 0);
    if (thread) {
      // The reviewer's follow-up on a quoted comment.
      if (!cur) cur = { parts: [], quoted: thread.quoted, reply: thread.reply, list: true, indent };
      cur.parts.push(line);
      thread = null;
      continue;
    }
    if (listMatch && (!cur || !cur.list || indent <= cur.indent)) {
      flush();
      cur = { parts: [line], quoted: [], reply: [], list: true, indent };
      continue;
    }
    if (cur && (cur.list ? indent > cur.indent || !STARTS_WITH_REF.test(t) : !STARTS_WITH_REF.test(t))) {
      cur.parts.push(line);
      continue;
    }
    flush();
    cur = { parts: [line], quoted: [], reply: [], list: false, indent };
  }
  flush();
  return { rounds, items };
}

function stripMarkers(s: string): string {
  return s.replace(/^\s*([-*+]|\d+[.)])\s+/, '').trim();
}

/** Expand "39/40", "52 and 53", "9, 10", "103-106" into separate numbers. */
function expandList(first: string, rest: string): string[] {
  const out = [first];
  const re = /\s*(,|\/|&|and|-|–|to)\s*([A-Z]?\d+(?:\.\d+)*[a-z]?)/gy;
  let m: RegExpExecArray | null;
  let prev = first;
  while ((m = re.exec(rest))) {
    const isRange = m[1] === '-' || m[1] === '–' || m[1] === 'to';
    const a = parseInt(prev, 10);
    const b = parseInt(m[2], 10);
    if (isRange && /^\d+$/.test(prev) && /^\d+$/.test(m[2]) && b > a && b - a <= 12) for (let k = a + 1; k <= b; k++) out.push(String(k));
    else out.push(m[2]);
    prev = m[2];
  }
  return out;
}

const LIST_TAIL = String.raw`((?:\s*(?:,|\/|&|and|-|–|to)\s*[A-Z]?\d+(?:\.\d+)*[a-z]?)*)`;
// Capitalised words ("Figure 2", "Tab. 3"), or abbreviations with a dot ("fig. 2"),
// so that "make this figure 2 columns wide" is not a reference.
const PATTERNS: [RefKind, RegExp][] = [
  ['figure', new RegExp(String.raw`\b(?:Fig(?:ure)?s?\.?|figs?\.)\s?(\d+[a-z]?)` + LIST_TAIL, 'g')],
  ['table', new RegExp(String.raw`\b(?:Tab(?:le)?s?\.?|tabs?\.)\s?(\d+)` + LIST_TAIL, 'g')],
  ['equation', new RegExp(String.raw`\b(?:Eq(?:uation)?s?\.?|eqs?\.)\s?\(?(\d+)\)?` + LIST_TAIL, 'g')],
  ['section', /\b(?:[Ss]ec(?:tion)?s?\.?|[Cc]hapter|App(?:endix)?\.?)\s?((?:\d+|[A-Z])(?:\.\d+)*)\b/g],
  ['cite', new RegExp(String.raw`\b(?:Refs?\.?|refs?\.?)\s?\[?(\d+)\]?` + LIST_TAIL, 'g')],
];

/** Find references in one line of Markdown; offsets are absolute. */
export function findRefs(text: string, base: number, round: number): CommentRef[] {
  // Blank out URLs so "record/1234567" or "#f8" are not taken for references.
  const clean = text.replace(/\bhttps?:\/\/\S+/g, (u) => ' '.repeat(u.length)).replace(/`[^`]*`/g, (u) => ' '.repeat(u.length));
  const refs: CommentRef[] = [];
  const taken: [number, number][] = [];
  const free = (s: number, e: number) => !taken.some(([a, b]) => s < b && e > a);
  const add = (r: Omit<CommentRef, 'start' | 'end' | 'text' | 'round' | 'now'>, s: number, e: number) => {
    if (!free(s, e)) return;
    taken.push([s, e]);
    const before = clean.slice(Math.max(0, s - 6), s);
    refs.push({ ...r, start: base + s, end: base + e, text: text.slice(s, e), round, now: /\bnow\s*$/i.test(before) });
  };

  // Line references: L12, L.12, L595-L597, L8-9, line 107, lines 3 to 5, and a bare "760-761:" at the start.
  const lineRe = /\b(?:L\.?\s?|lines?\s+|l\.\s?)(\d{1,4})(?:\s?(?:-|–|—|to)\s?(?:L\.?\s?)?(\d{1,4}))?(?![\d.]*\s?(?:fb|GeV|MeV|TeV|%))(?![A-Za-z\d])/gi;
  for (let m; (m = lineRe.exec(clean)); ) {
    if (/[A-Za-z]$/.test(clean.slice(0, m.index))) continue;
    const from = +m[1];
    const to = m[2] ? +m[2] : from;
    // "L0" is the LHCb hardware trigger, not a line.
    if (from === 0 || to < from) continue;
    add({ kind: 'line', from, to, ids: [] }, m.index, m.index + m[0].length);
  }
  const bare = /^(\s*(?:[-*+]\s+)?)(\d{1,4})\s?[-–]\s?(\d{1,4})\s*:/.exec(clean);
  if (bare && +bare[3] >= +bare[2]) add({ kind: 'line', from: +bare[2], to: +bare[3], ids: [] }, bare[1].length, bare[1].length + bare[2].length + 1 + bare[3].length);

  for (const [kind, re] of PATTERNS) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(clean)); ) {
      const ids = kind === 'section' ? [m[1]] : expandList(m[1], m[2] ?? '');
      add({ kind, from: 0, to: 0, ids }, m.index, m.index + m[0].length);
    }
  }
  return refs.sort((a, b) => a.start - b.start);
}

/** Quoted text: "…", “…”, ‘…’ and '…' (not apostrophes). The text before an arrow is the old text. */
export function findSnippets(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"\n]{2,120})"|“([^”\n]{2,120})”|‘([^’\n]{2,120})’|(?:^|[\s(])'([^'\n]{2,120})'(?=[\s.,;:)?!]|$)/g;
  for (let m; (m = re.exec(text)); ) {
    const s = (m[1] ?? m[2] ?? m[3] ?? m[4]).trim();
    const after = text.slice(re.lastIndex, re.lastIndex + 4);
    const before = text.slice(Math.max(0, m.index - 4), m.index);
    // In `"old" -> "new"` only the old text is in the note under review.
    if (/(->|→|=>)\s*$/.test(before)) continue;
    if (s.split(/\s+/).length > 25) continue;
    out.push(s);
    void after;
  }
  return out;
}

/** Remove an item's lines from the Markdown, without leaving a run of blank lines. */
export function removeItem(md: string, item: CommentItem): string {
  const before = md.slice(0, item.span[0]);
  const after = md.slice(item.span[1]);
  return (before + after).replace(/\n{3,}/g, (m, at: number) => (at <= before.length && at + m.length >= before.length ? '\n\n' : m));
}

/** Short, stable hash of a string (FNV-1a, hex). */
function stableKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
