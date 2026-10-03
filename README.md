# PDF diff viewer

Compare versions of an LHCb analysis note (or paper draft) side by side, in the
browser. Built for the things that make generic PDF diff tools useless on ANA
notes:

- **Line numbers move.** Text is compared word by word after removing the
  line-number column, page numbers and headers, so reflowed paragraphs and
  shifted numbering do not show up as changes. Versions without line numbers
  work too.
- **Figures change.** Each `\includegraphics` is located in the PDF and
  fingerprinted; unchanged figures are recognised instantly, the others are
  rendered and compared visually (side by side, blink, difference, swipe).
  Renumbered figures are matched through their captions.
- **Review comments cite old line numbers.** Paste your Markdown review and
  every `L123`, `L8-9`, `Figure 4`, `Table 9 and 10`, `Eq. 12`, `Sec. 4.1` or
  `Ref. 29` is followed into the new version, with a status (unchanged,
  changed, removed). Quoted text (`"teh" -> "the"`) pins down the exact words.
  Review rounds are matched to the version they were written on automatically.
  Export the review with the new locations added after each reference.

- **Export to send around.** Either a side-by-side diff PDF (old page next to
  the matching new page, changes highlighted, a linked list of all changes in
  front) or the new version with standard PDF annotations (highlights with
  "was: …" notes).

Everything runs locally in the browser tab: PDFs and comments are never
uploaded. Comparisons are saved in the browser (IndexedDB) automatically: a
reload brings back where you were, and the start page lists recent
comparisons. "Clear stored data" on the start page removes everything.

## Using it

Open the page, drop two or more PDFs on it.

- The change list (left) groups changes by section. Filters: text, numbers
  (only numbers changed, e.g. results), moved text, figures, renumbering
  (hidden by default) and the table of contents (hidden by default).
- Click a change or a highlight to jump; `j`/`n` and `k`/`p` step through the
  changes. Scrolling is synchronised between the two versions.
- With more than two versions loaded, pick the pair at the top.
- **Comments tab:** paste or load the review. Each `## Round …` heading is
  coupled to a version (adjustable). Clicking a comment highlights the cited
  text in both versions. "History" shows the status in every later version.
  Tick comments off as done, delete single ones (with undo) or remove all.
- Text on the pages and in the lists can be selected and copied; the browser's
  find (Ctrl+F) searches the PDFs too. The theme button switches between
  system, light and dark.
- **Export** (header) writes the comparison as a PDF; renumbering and your
  comments are left out unless you tick them.

## Development

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests (+ sample tests when examples/ exists)
npm run build        # dist/index.html, a single self-contained file
```

`dist/index.html` also works opened from disk; the standard PDF fonts
(`dist/standard_fonts/`) are only needed for PDFs that do not embed their
fonts.

Sample notes are not part of the repository (they are collaboration material).
Put them in `examples/` (git-ignored), together with any `*.test.ts` that
checks them, and `npm test` picks those up too. The scripts:

```bash
npx tsx scripts/inspect.ts examples/note.pdf 12          # extraction of page 12
npx tsx scripts/check-samples.ts old.pdf new.pdf         # alignment statistics
npx tsx scripts/dev/check-comments.ts review.md target.pdf v1.pdf v2.pdf ...
npm run e2e -- http://localhost:5173/ out/ old.pdf new.pdf   # BROWSER=firefox for Firefox
```

### How it works

| Step | Code |
|---|---|
| Text with positions per page (pdf.js), split into words | `src/extract/words.ts` |
| Line-number column (lineno), lines with sub/superscripts folded in | `src/extract/linenumbers.ts`, `src/extract/lines.ts` |
| Figure placements, table rules and figure fingerprints, read straight from the content streams | `src/pdf/scan.ts` |
| Captions, figures, tables, equations, sections (PDF outline), headers/footers | `src/extract/structure.ts` |
| Word alignment: unique-shingle anchors + exact diff between them, moved blocks, change classification | `src/align/diff.ts`, `src/align/align.ts` |
| Matching figures/tables/equations/sections across versions | `src/align/objects.ts` |
| Visual figure comparison with registration | `src/figures/compare.ts` |
| Review parsing, round coupling, resolution, export | `src/comments/` |

Broken text layers (e.g. a PDF re-printed from a browser, where ligatures and
minus signs become private-use glyphs) are detected and flagged;
`repairText()` in `src/extract/normalize.ts` is the hook for a future repair or
OCR step.
