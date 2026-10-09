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
  Renumbered figures are matched through their captions; if a pairing is wrong,
  "Wrong pair?" on the entry lets you choose the right one.
- **Review comments cite old line numbers.** Paste your Markdown review and
  every `L123`, `L8-9`, `Figure 4`, `Table 9 and 10`, `Eq. 12`, `Sec. 4.1` or
  `Ref. 29` is followed into the new version, with a status (unchanged,
  changed, removed). Quoted text (`"teh" -> "the"`) pins down the exact words.
  Review rounds are matched to the version they were written on automatically.
  Export the review with the new locations added after each reference.

- **Navigate.** Links inside the PDF (Figure 3, Section 4.1, citations, table
  of contents) work in both panes, shown with their PDF borders. The
  **Contents** tab lists the sections with the number of changes in each; a
  click shows the section in both versions. Formulas in review comments
  (`$B^0 \to D\pi$`) are typeset.

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
- Click a change in the list to jump to it in both versions, or click a
  highlight on a page to find its entry in the list. `j`/`n` and `k`/`p` step
  through the changes. Scrolling is synchronised between the two versions,
  and the list on the left scrolls along, marking the entries that are on
  screen.
- The page box in each pane header shows the current page; type a number and
  Enter to go there (`g` jumps to the box).
- Moved text (a paragraph that now sits elsewhere) is underlined in purple and
  listed once. Figures and tables that LaTeX merely placed differently are not
  reported as moved.
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
npm run test:public  # public tests only, even when examples/ exists
npm run test:private # local sample tests only (requires examples/)
npm run build        # dist/index.html, a single self-contained file
npm run e2e:smoke    # test the build in Firefox with generated, invented PDFs
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

### Continuous integration and confidential documents

GitHub Actions checks pushes to `main` and pull requests with TypeScript, public
tests, a production build and a Firefox smoke test. The smoke test creates its
own invented PDFs (with figures and captions) and checks text/number changes,
figure pairing across renumbering, saved comments, reload, worker cleanup,
retrying failed loads and clearing stored data. Only successful checks on `main`
deploy to GitHub Pages; pull requests have read-only repository permissions.

The public suite also generates small PDFs in memory to check exact text and
number changes, reflow and line numbering, reference renumbering, paragraph
reordering and page deletion. It reopens both export formats with pdf.js to
verify preserved text, highlight positions, deletion carets and summary links.
These checks use the existing dependencies and take a few seconds locally.

Internal notes, reviews, filenames and results derived from them must stay in
the ignored `examples/` directory. Keep their regression tests there too, and
run `npm run test:private` locally. Do not upload their logs, screenshots or
exports as CI artifacts. Public CI needs no access to those files or to a
machine that holds them. Git ignores are a convenience, not a confidentiality
check: inspect staged changes before committing.

The smoke test uses `/snap/bin/firefox` locally; set `BROWSER_PATH` to use a
different Firefox executable. CI installs Firefox stable. Generated files and
browser profiles go under the ignored `e2e-tmp/` directory.

If figure comparison fails, the affected figures remain unclassified and a
visible note explains how to retry; a failure is not reported as a change.

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

The version is shown next to the title; release notes are in [CHANGELOG.md](CHANGELOG.md).
The page offers a reload when a newer build has been deployed.
