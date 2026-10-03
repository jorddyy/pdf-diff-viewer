# CLAUDE.md

Browser-only diff viewer for versions of LHCb analysis notes (ANA-notes) and
paper drafts. Live at https://jorddyy.github.io/pdf-diff-viewer/ (GitHub Pages,
deployed on every push to `main`). The owner uses it in **Firefox**; keep
Firefox the primary target.

## Confidentiality: read first

- The repository is **public**. Real notes, reviews and anything derived from
  them (file names, analysis numbers, quoted comments, expected results)
  must never be committed.
- `examples/` is git-ignored and holds the real sample notes, review Markdown,
  the proponents' replies and `examples/samples.test.ts` (ground-truth tests).
  **Read `examples/NOTES.md`** for what is there and what each sample is good for.
- Unit-test fixtures (`test/fixtures/`) are made-up. Keep them neutral: no
  phrases, record numbers or numbers copied from real reviews.
- The app itself never uploads anything: PDFs and comments stay in the tab
  (IndexedDB cache and localStorage only). Do not add network calls that send
  document content anywhere.

## Commands

```bash
npm run dev            # Vite dev server (http://localhost:5173)
npm run typecheck      # tsc --noEmit (TypeScript 7)
npm test               # vitest: test/** and, locally, examples/**/*.test.ts (slow, ~1 min)
npm run build          # dist/index.html, single self-contained file (+ dist/standard_fonts/)
npx tsx scripts/inspect.ts file.pdf [page]                # what extraction sees
npx tsx scripts/check-samples.ts old.pdf new.pdf [--list N]  # alignment stats + sample changes
npx tsx scripts/dev/list-changes.ts old.pdf new.pdf numeric|renumber|text|toc [kind]
npx tsx scripts/dev/check-comments.ts review.md target.pdf v1.pdf v2.pdf ...   # ROUND=n filters
npx tsx scripts/dev/parse-comments.ts review.md           # parser output
npx tsx scripts/dev/debug-figure.ts old.pdf new.pdf 59    # why a figure (mis)matches
npx tsx scripts/dev/compare-scan.ts file.pdf              # scanner vs pdf.js operator list
npx tsx scripts/dev/find-hash.ts file.pdf <hash>...       # which figure has a fingerprint
```

Browser tests (puppeteer-core, no bundled browser):

```bash
npm run e2e -- <url> <out-dir> old.pdf new.pdf            # screenshots + timings
npm run e2e:comments -- <url> <out-dir> review.md a.pdf b.pdf [...]
# env: BROWSER=firefox, DARK=1 (Chromium), FIGURE="Figure 32", PICK="L477", WAIT=6000, HISTORY=1
```

- `<url>` can be `http://localhost:5173/`, `file://$PWD/dist/index.html` or the live site.
- Browsers are the snaps: `/snap/bin/chromium` and `/snap/bin/firefox`. The
  chrome-devtools MCP cannot find Chrome on this machine; use these scripts.
- Snap Firefox cannot see `/tmp`, so the scripts put its profile in
  `e2e-tmp/` (ignored). Screenshots also go there; read them to check the UI.

## Architecture

Pipeline: **extract** (per document) → **align** (per pair) → **UI**. All of it
is plain TypeScript running in the browser; Node runs the same code for
scripts and tests (`scripts/node-pdf.ts` provides pdf.js legacy build + zlib).

| Stage | Files | Notes |
|---|---|---|
| Load | `src/pdf/load.ts` | pdf.js with inline workers; extraction spreads pages over 2–4 workers; `openForCompare` gives figure rendering its own workers so panes stay responsive |
| Fast figure/rule finder | `src/pdf/scan.ts` | Own minimal PDF reader (xref tables/streams, object streams, Flate + PNG predictors, q/Q/cm/Do/re/m/l). Gives XObject placements, table rules and **fingerprints** (hash of raw XObject bytes + nested XObjects). Falls back to pdf.js `getOperatorList` (`src/extract/graphics.ts`) per page on any error. ~3× faster than pdf.js for plot-heavy notes |
| Words | `src/extract/words.ts` | pdf.js text runs split at whitespace; word boxes estimated with Computer Modern widths |
| Line numbers | `src/extract/linenumbers.ts` | lineno column = margin integers aligned on one edge, mostly +1 in reading order |
| Lines | `src/extract/lines.ts` | numbered baselines anchor lines; sub/superscripts attach to the nearest main row; `√` is shifted onto its radicand's baseline |
| Structure | `src/extract/structure.ts` | headers/footers, TOC, captions, figures (graphics under/over captions), tables (rules), numbered equations, sections from the PDF outline |
| Document | `src/extract/document.ts` | orchestrates the above into `DocModel` (`src/extract/types.ts`) |
| Tokens | `src/align/tokens.ts` | reading-order words, hyphenation undone, thin-space digit groups merged (`497 052` = `497052`) |
| Diff | `src/align/diff.ts` | unique 4-shingle anchors (LIS) + exact LCS in gaps (≤ `MAX_CELLS`), recursive unique-token anchors for big gaps |
| Changes | `src/align/align.ts` | moved blocks, grouping (bridges ≤ 3 equal tokens), classes `text`/`numeric`/`renumber`/`toc`, snippets for the list |
| Objects | `src/align/objects.ts` | figure/table/equation matching via caption-token votes, then fingerprints, then number, then same-page position; section matching |
| Figures | `src/figures/compare.ts` | render once per page, crop panels, register (global shift), ink-difference ratio > `CHANGED_THRESHOLD` = changed |
| Comments | `src/comments/` | `parse.ts` (Markdown → items + refs + snippets), `assign.ts` (round → version), `resolve.ts` (ref → location + status in target), `export.ts` (annotated Markdown) |
| UI | `src/app.tsx`, `src/ui/*` | Preact. Panes render pages lazily (IntersectionObserver), overlays are absolutely positioned marks keyed `t<change>` / `f<figure match>` / `c<comment>` |

Key decisions (and why):

- **Line-number anchoring.** The lineno numbers give each body line its number
  and baseline. Captions, equations and table rows have none, which is how they
  are recognised in numbered documents.
- **Text inside figure regions is excluded from the text diff.** Axis labels
  and legends would otherwise flood the change list. Figures are compared
  visually instead.
- **Fingerprints first, rendering only when needed.** Most figures are
  byte-identical between versions; only the rest are rendered.
- **Comment status = the leading reference's status.** In "L242: … like
  Fig. 2", the figure is incidental context.
- **Round coupling** (`assign.ts`) scores each version by quoted snippets found
  on the cited line (1 point) or within ±3 lines (½ point). Rounds without
  evidence are slotted in order between neighbours, or left unassigned.
- **Alignments are computed per pair on demand and cached** (`alignCache` in
  `app.tsx`). Comment history resolves source → each later version directly,
  not by chaining.

## Gotchas learned the hard way

- **pdf.js 6 API.** `PDFDocumentProxy` has no `destroy()`; use
  `pdf.loadingTask.destroy()`. The `PDFWorker({ port })` typing is wrong, so
  cast it.
- **pdf.js render `transform`** is applied in device pixels (after the viewport
  transform). `constructPath` args are `[paintOp, [pathData], minMax]`.
- **pdf.js wraps pages that have a transparency group** in
  `paintFormXObjectBegin` with a `null` bbox. That is not a figure; see
  `realForms` in `graphics.ts`.
- **Workers must be classic (IIFE).** `vite.config.ts` sets
  `worker.format: 'iife'`; module workers from blob URLs fail when the build is
  opened via `file://` in Chromium.
- **Standard fonts on `file://`.** `standard_fonts/` fetches are disabled there
  (CORS); pdf.js then uses system fonts.
- **Bump `EXTRACT_VERSION` in `src/pdf/cache.ts`** whenever extraction output
  changes. Otherwise browsers keep serving cached `DocModel`s from IndexedDB.
- **"L0" is the LHCb trigger, not a line.** The parser skips line 0 and
  "L0Hadron"-like tokens. Figure, table and equation words must be capitalised
  or abbreviated with a dot ("figure 2 columns" is not a reference).
- **Snippets:** in `"old" -> "new"` only the old text is searched. Reviewers are
  sometimes one line off, so the nearest occurrence within ±3 lines wins.
- **Renumbering vs numbers:** a number change is `renumber` when preceded by
  Fig./Table/Eq./Sec./Ref., bracketed (`[23]`, `(13)`), or the first word of a
  heading. Otherwise it is `numeric`; those matter (changed results).
- **Moves:** an equal run must be ≥ 10 tokens with ≥ 6 real words. Otherwise
  shared formulas like "B0 → D−π+" create false moves.
- **Fit to width:** the default zoom is `null` (fit page width). With fixed
  zoom, line ends can be off-screen; `PaneControl.scrollTo` also scrolls
  horizontally to the target.

## Known limitations / ideas

- Two-column layouts: reading order is by rows; columns are not split.
- Display equations: maths token order can give noisy "Edited" entries;
  maybe give equations their own class.
- Re-rendered plots at a slightly different scale show as changed; registration
  only handles shifts, not scaling.
- Broken text layers (browser re-prints with private-use glyphs) are only
  flagged (`quality.ok`). `repairText()` in `src/extract/normalize.ts` is the
  hook for glyph-map learning or OCR.
- Page analysis of 100 pages takes ~7–10 s; text extraction (pdf.js
  `getTextContent`) is now the bulk.

## Conventions

- TypeScript strict, Preact function components with hooks; no UI or CSS
  framework. Colours are CSS custom properties in `src/styles.css`, with light
  and dark mode.
- Comments explain *why*, sparingly; match the surrounding density.
- Commit only when asked. Commits in this repo use the owner's GitHub
  no-reply address (set in the local git config). End messages with the
  `Co-Authored-By` line given by the harness.
- Before pushing: `npm run typecheck && npm test && npm run build`, and run the
  e2e script in Firefox for UI changes. CI runs typecheck, tests and build
  before deploying.
