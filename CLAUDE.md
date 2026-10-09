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
npx tsx scripts/dev/e2e-links.ts <url> <out-dir> old.pdf new.pdf     # finds a PDF link, clicks it, checks the pane scrolled
npx tsx scripts/dev/e2e-contents.ts <url> <out-dir> old.pdf new.pdf  # Contents tab: click a section, both panes scroll
npx tsx scripts/dev/e2e-repair.ts <url> <out-dir> old.pdf new.pdf    # "Wrong pair?" on a figure entry: choose none, entries change
```

Browser tests (puppeteer-core, no bundled browser):

```bash
npm run e2e -- <url> <out-dir> old.pdf new.pdf            # screenshots + timings
npm run e2e:comments -- <url> <out-dir> review.md a.pdf b.pdf [...]
npx tsx scripts/e2e-viewer.ts <url> <out-dir> old.pdf new.pdf       # theme, sync scroll, list follows, landscape, selection, click-to-reveal, go to page, panels (PASS/FAIL)
npx tsx scripts/e2e-session.ts <url> <out-dir> review.md a.pdf b.pdf # comments done/delete/undo, reload restore, recent list (PASS/FAIL)
npx tsx scripts/e2e-export.ts <url> <out-dir> old.pdf new.pdf       # writes export-side.pdf / export-annotated.pdf
# env: BROWSER=firefox, DARK=1 (Chromium), FIGURE="Figure 32", PICK="L477", WAIT=6000, HISTORY=1
```

- `<url>` can be `http://localhost:5173/`, `npx vite preview` (production build over http, like Pages), `file://$PWD/dist/index.html` or the live site.
- Each puppeteer run starts with a fresh browser profile, so saved comparisons start empty.
- Stop a background dev server by its port (`ss -ltnp | grep 5199`, then `kill <pid>`). Do not use `pkill -f` or `pgrep -f` with a pattern: it also matches the shell running it and kills that command.
- Count annotations in exported PDFs with pdf.js (`page.getAnnotations()`); a grep of the file finds nothing because pdf-lib writes object streams.
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
| Changes | `src/align/align.ts` | Running text and floats (captions, table contents) are separate streams: floats are paired by content (`pairFloats`) and aligned pair by pair, so LaTeX float placement never shows as a move. Moved blocks (running text only) are merged (`mergeMoves`) and refined, carrying `move` info for the list. Grouping (bridges ≤ 3 equal tokens), classes `text`/`numeric`/`equation`/`renumber`/`toc` (`equation` = text edits inside a display equation; pure number changes there stay `numeric`), snippets for the list |
| Objects | `src/align/objects.ts` | figure/table/equation matching: caption-token votes (an extended caption still counts with ≥ 5 shared words and ≥ 35 % of the shorter caption), then fingerprints, then a similar-wording pass (Dice ≥ 0.4, order kept), then same number **only if** `unrelated()` is false, then same-page position; section matching. `matchObjects(A, B, al, overrides)` takes the user's `PairOverride`s (kind + number, per `oldHash:newHash`, stored in the workspace): forced pairs, or "no counterpart"; edited through `ui/PairDialog.tsx` ("Wrong pair?" / "Pair with…" on the selected figure or renumbering entry). They change figure comparison and renumbering, not the caption text diff, which comes from `pairFloats` |
| Figures | `src/figures/compare.ts` | render once per page, crop panels, register (`register()`: global shift plus a small global scale 0.9–1.1, only when it clearly lowers the cost; a scaled match gets a 2 % noise allowance and a 2 px edge tolerance), ink-difference ratio > `CHANGED_THRESHOLD` = changed |
| Comments | `src/comments/` | `parse.ts` (Markdown → items + refs + snippets), `assign.ts` (round → version), `resolve.ts` (ref → location + status in target), `export.ts` (annotated Markdown) |
| UI | `src/app.tsx`, `src/ui/*` | Preact. Each pane header has a `PageBox` (current page, type a number to jump; `g` focuses it; `PaneControl.listeners` update it on scroll). The compare dialog hides blink/difference/swipe when no panel exists in both versions. Panes render pages lazily (IntersectionObserver) with a pdf.js `TextLayer` (selectable text, browser find). Marks are drawn under the text layer with `pointer-events: none`; a click on a page hit-tests them (`onMarkClick`), switches the sidebar tab and bumps `reveal`, which centres and flashes the entry (`revealEntry`), even if it was already selected. The other way round, user scrolling of the PDFs calls `followRef` with the visible range of the new version; the open list marks entries on screen (`.inview`, `followList`) and scrolls the first one to the top (`scrollToTop`). Only user scrolls trigger it (the sync leader), never navigation. Keys: `t<change>`, `f<figure match>`, `r<renumbered object>`, `c<comment>`. Sidebar tabs: Changes, Contents, Comments (`tab` is saved in the workspace) |
| Saved comparisons | `src/pdf/workspaces.ts` | IndexedDB: PDFs by SHA-256 plus a workspace per comparison (pair, filters, zoom, scroll, comments, round overrides, done ticks). Auto-saved (debounced), the newest is restored on load, the start page lists them (max 15) |
| Links | `src/ui/PdfPane.tsx` | `page.getAnnotations()` gives the PDF's Link annotations per visible page; `PageLink` boxes are drawn with the PDF's own border (colour/width) in `.overlay.links`. A click goes to `resolveDest` (named or explicit destination → page + y, `PaneControl.scrollToDest`) or opens the URL in a new tab. A link wins over a highlight; Alt-click picks the highlight. Following a link pushes the scroll position on `PaneControl.history`; the "← Back" button (only shown then), Alt+← or the mouse back button return, and the other pane follows |
| Contents | `src/ui/ContentsPanel.tsx` | Third sidebar tab: outline of the new version's sections (`matchSections`), removed old sections after their closest surviving predecessor, per-section change counts that follow the filters; click → `goToSection` in `app.tsx` scrolls both panes (one-sided sections via the sync map); the current section follows scrolling through `followRef` |
| LaTeX | `src/ui/Tex.tsx` | Temml (MathML, no fonts to bundle) typesets `$…$`, `$$…$$`, `\(…\)`, `\[…\]` in comment text, quotes and replies. `$` next to a space or digit is money; unparsable formulas stay as typed |
| Version | `src/version.ts`, `vite.config.ts` | `BUILD` (package version, git commit, build time) is injected via `define`; the build writes `dist/version.json`; the app fetches it (https only, GET only) and offers "Update available · reload" when the deployed commit is newer |
| Export | `src/export/` | `@pdfme/pdf-lib` (maintained pdf-lib fork). `sideBySide.ts`: old/new pages embedded as vector via the stored viewport transform, viewer marks redrawn, summary pages with links. `annotated.ts`: new PDF + Highlight/Caret/Square/Text annotations (viewer coords → user space by inverting the viewport transform). `pairing.ts`: which old page goes next to each new page |

Key decisions (and why):

- **Line-number anchoring.** The lineno numbers give each body line its number
  and baseline. Captions, equations and table rows have none, which is how they
  are recognised in numbered documents.
- **Text inside figure regions is excluded from the text diff.** Axis labels
  and legends would otherwise flood the change list. Figures are compared
  visually instead.
- **Fingerprints first, rendering only when needed.** Most figures are
  byte-identical between versions; only the rest are rendered.
- **Float and equation numbers are placeholders in the alignment** (`tokens.ts`). The captions `Figure 35:` and equation numbers `(13)` would otherwise anchor wrong figures when everything shifted by one. Renumbering is reported from `matchObjects` instead (`r…` entries).
- **Sync scroll is driven by input, not by scroll events.** Wheel, keys, pointer or touch on a pane makes it the leader (`onUserInput`); scroll events of the other pane are ignored, so panes cannot push each other. Navigation (`select`) clears the leader. Mapping is piecewise linear in continuous document coordinates over a strictly increasing anchor chain (`ui/sync.ts`).
- **Fit to width uses the median page width**; pages wider than the pane (landscape) get their own scale (`PaneControl.scales`).
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
  shared formulas like "B0 → D−π+" create false moves. Pieces of one block are
  merged. Inside a block, leftover words are re-aligned, and one- or two-word
  coincidental pairings with text outside the block are freed and only kept
  if nothing better is found. A real reorder (e.g. two groups of paragraphs
  swapped) is reported once, for the smaller group.
- **Floats are not running text.** Caption and table lines (with a figure or table object) are aligned only against their paired float. Sync-scroll anchors skip them too.
- **Number classification** is `classifyPair()` in `align.ts`. Only whole numbers or ranges (`Figs. 17–19`) in reference positions are `renumber`; decimals or values inside expressions are always `numeric`. Example: `(1.23 ± 0.04)` → `(1.31 ± 0.05)` must be a number change.
- **Rotated pages:** orientation comes from `text transform × viewport transform` (`words.ts`). `/Rotate 90` landscape tables are upright on screen but rotated in PDF space.
- **Table superscripts** attach by their *start* x, with the row growing as pieces join (`lines.ts`). Unanchored text rows count as main rows in numbered documents too, so tables build identically with and without line numbers.
- **Captions** ending in "." need caption text and a caption font or nearby graphics (`captionStart()`). "Fig. 23." can start a body line after a wrap.
- **Cropped plots** keep their titles as invisible text just outside the graphic. Small text within 12 pt of a graphic is excluded (`document.ts`).
- **Standard PDF fonts** only cover WinAnsi; `export/text.ts` spells out Greek letters and arrows for the summary pages. Annotation contents use UTF-16 (`PDFHexString.fromText`), so they need no sanitising.
- **Fit to width:** the default zoom is `null` (fit page width). With fixed
  zoom, line ends can be off-screen; `PaneControl.scrollTo` also scrolls
  horizontally to the target.

- **Tabs by name in scripts.** The sidebar tabs are Changes / Contents /
  Comments; e2e scripts must find them by text, not by index.
- **Same number is weak evidence.** Figures, tables and equations of two
  versions often keep a number while the content changed or moved
  (`unrelated()` in `objects.ts`): figures/tables need caption similarity ≥ 0.3,
  or ≥ 0.15 and about the same relative page; equations need formula
  similarity ≥ 0.2 (a short formula never pairs with a long one). Caption
  words are compared without punctuation (`m(D0K+),` = `m(D0K+).`), one-letter
  tokens ignored.
- **Version label.** The file name wins over the title page
  (`resolveLabel` in `app.tsx`); a hint shows when the title page differs
  (`v1`, `v1.0`, `v1.0.0` count as equal). `DocModel.label` still stores the
  title-page label, so the extraction cache needs no bump.
- **Compare dialog** panels use `flex: none`; otherwise several large panels
  are squeezed instead of scrolling.

## Known limitations / ideas

- Equations are paired by votes and formula similarity only; renumbered or
  split equations in heavily rewritten notes can still be unpaired (the
  "Wrong pair?" dialog only reaches equations that show up as a renumbering).
- Figure registration handles one global shift and scale; a plot re-rendered
  with different relative proportions (axis ranges) still counts as changed.
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
- The single-file build is ~2.6 MB (865 kB gzip): pdf-lib and Temml are the large additions.

## Releases

- `package.json` holds the version (SemVer, 0.x). `vite.config.ts` injects it
  with the git commit and build time (`src/version.ts`, shown next to the title)
  and writes `dist/version.json`; the running app compares itself with it and
  offers a reload.
- User-visible changes go into `CHANGELOG.md` under "Unreleased" as you work (the 0.2.0 section was written at its first release).
  To release: bump the version (`npm version minor --no-git-tag-version`),
  rename "Unreleased" to the version and date, commit, then `git tag vX.Y.Z`
  and push the tag. Only do this when asked. Pushing a `v*` tag runs
  `.github/workflows/release.yml`, which checks the tag against `package.json`
  and `CHANGELOG.md` and creates the GitHub release from that changelog section.

## Conventions

- TypeScript strict, Preact function components with hooks; no UI or CSS
  framework. Colours are CSS custom properties in `src/styles.css`, with light
  and dark mode.
- Comments explain *why*, sparingly; match the surrounding density.
- **Keep the documentation up to date in the same change:** `CLAUDE.md`
  (architecture table, gotchas, commands), `README.md` (user-facing features)
  and `CHANGELOG.md` ("Unreleased" section) whenever behaviour, commands,
  files or limitations change. Do not leave it for later.
- Commit only when asked. Commits in this repo use the owner's GitHub
  no-reply address (set in the local git config). End messages with the
  `Co-Authored-By` line given by the harness.
- Before pushing: `npm run typecheck && npm test && npm run build`, and run the
  e2e script in Firefox for UI changes. CI runs typecheck, tests and build
  before deploying.
