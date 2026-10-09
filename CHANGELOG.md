# Changelog

All notable changes to the PDF diff viewer. Versions follow
[Semantic Versioning](https://semver.org/) (0.x: the interface may still change);
the format follows [Keep a Changelog](https://keepachangelog.com/).
The running version is shown next to the title in the app (hover for the commit).

## [Unreleased]

### Added
- "← Back" button (and Alt+←, mouse back button) after following a link inside the PDF.
- **Equations** filter: edits inside display equations are their own class
  (number-only changes stay under Numbers).
- "Wrong pair?" / "Pair with…" on a selected figure or renumbering entry: choose
  which figure, table or equation belongs together, or none. Saved with the comparison.
- Pushing a `v*` tag creates the GitHub release from this changelog.

### Changed
- Figure comparison tolerates a plot that was re-rendered at a slightly different size.

## [0.2.0] - 2026-10-09

### Added
- Links inside the PDF work again (Figure, Table, Section, references, table of
  contents, URLs), drawn with the border colour of the PDF. A click on a link
  wins over a highlight underneath; Alt-click selects the highlight.
- **Contents** tab: section outline with the number of changes per section,
  new and removed sections marked; click shows the section in both panes and
  the current section follows scrolling.
- LaTeX in review comments, quotes and replies is typeset (`$…$`, `$$…$$`).
- The comments list shows the proponents' replies.
- Version number next to the title, with a link to these release notes, and an
  "Update available" button when a newer build is deployed.

### Changed
- The version label comes from the file name first; the title page is the
  fallback. A hint appears when the title page names a different version.
- The compare dialog scrolls when several large panels changed.
- "Moved from page X" is no longer reported for floats; moves are shown compactly.

### Fixed
- Figures, tables and equations with the same number but unrelated content are
  no longer paired; extended or reworded captions still find their partner,
  and series such as zoomed views keep their order. Equations are only paired
  by number when their formulas look alike.

## [0.1.0] - 2026-10-03

### Added
- First public version: side-by-side diff of two PDF versions with
  line-number-aware text alignment, figure comparison (side by side, blink,
  difference, swipe), review-comment tracking across versions, saved
  comparisons in the browser, and export to a side-by-side PDF or an annotated PDF.
