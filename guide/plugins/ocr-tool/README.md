# Auto OCR — `ocr_tool`

Byte-exact OCR of the page rasters, running entirely in the browser. The
toolbar's scanner button opens a subtoolbar with **This page** / **All pages**;
every line the reader certifies lands in the unified text box system as an
editable `type: 'ocr'` box — the same pipeline `embedded_text_viewer` feeds
embedded spans through — and detected redaction rectangles land as
`type: 'redaction'` boxes.

## Auto read + layer choice

Every loaded document is read automatically (`document:loaded` → all pages,
fire-and-forget). When the run settles the adapter compares non-whitespace
character counts of the `ocr` and `embedded` layers and shows exactly one:

- OCR volume within 80% of the embedded layer (`OCR_AUTO_SIMILARITY`), or no
  embedded text at all (scanned pages) → **OCR layer shown**, embedded hidden
  (the reader's measured ¼-px pens beat PDF extraction).
- OCR read substantially less → embedded stays, the OCR overlay is hidden so
  the two layers never draw on top of each other.

The choice just flips the existing body classes (`hide-ocr-text` /
`hide-embedded-text`) **and** both toolbar toggle buttons' active state, so
manual toggling afterwards starts from a state that matches the screen; the
verdict is appended to the status line. Loading a new document mid-run
cancels the old run before the new auto read starts. Manual runs never flip
layers.

This matters for scanned/eDiscovery documents: their pages are images, so the
embedded-text extractor has nothing to read. The blind reader recovers the
text from the pixels — *certified, not guessed*: a line is byte-clean only
when its glyphs reproduce the page bytes exactly through the producer's
proven blend law; anything unexplained is an honest `□`.

## The engine is developed elsewhere

`static/ocr_tool/engine/` (`core.js`, `ocr.js`, `blindocr.js`) and
`static/ocr_tool/glyphs/` are **verbatim copies** from the external
`char_training` repo (`Desktop/char_training`), where the reader is developed
and certified against a multi-document corpus gate. **Never edit those copies
here.** The workflow:

1. Edit the engine in `char_training`, run its regression gate.
2. `npm run sync:recto` there — copies the engine + glyph sets in and rewrites
   the cache-buster hashes in this plugin's `tool.py`.
3. `npm run recto-test` there — headless end-to-end smoke: boots this Django
   app, runs Auto OCR on the bundled default document, asserts byte-clean
   boxes. (`npm run sync:recto -- --check` reports staleness without writing.)

Only `ocr-tool.js` (the adapter: UI wiring, page-raster → engine buffer,
lines → UnifiedTextBoxes) is owned by this app and edited here.

## How it reads

- Input pixels are `state.pageImages` — the server-extracted, ratio-cropped
  page rasters the viewer displays, so OCR coordinates line up with the page
  by construction. Coordinates scale into the 816×1056 viewBox space
  (scale = 1.0 for the standard 96-dpi document family).
- Passes escalate exactly like the char_training app: byte-exact first (plain
  → palette-quantized → same-size mixed-font union pools), per-pixel
  tolerances only after that, and the status line always names the weakest
  machinery used (`byte-clean`, `clean@±1 (palette)`, …). The winning pass is
  reused as the first try on the next page.
- Per-glyph measured ¼-px pens go into `baseCharPositions`, so the SVG
  overlay reproduces the original character placement; the box `y/h` are
  chosen so `computeBaseline()` returns the *measured* baseline exactly.
- Line font/bold/italic/size come from the winning glyph set
  (`timesbd16` → Times New Roman bold 12 pt, `cour13` → Courier New 9.75 pt).
- Non-byte-clean lines render in orange (`box.color` override); unreadable
  bands become red `□` marker boxes. `box.ocr = {clean, tol, quant, union,
  font, baseline, fails}` rides on every box for downstream tooling.
- Detected redaction rectangles become `redaction` boxes and are snapped to
  their text lines via the guarded `utbConnectRedactionsToLines?.()` seam.

## Dependencies and seams

- **Requires `text_tool`** — boxes are `UnifiedTextBox`es rendered by
  `svg-renderer.js` (which defines the `ocr` type colors).
- **`embedded_text_viewer` is optional** — when present, its redaction
  line-connect treats `ocr` lines as text lines; when absent the call
  no-ops.
- The type-level seams in the baseline (`'embedded' || 'ocr'` filters in
  `unified-text-box.js` / `etv-fetch.js`, the `ocr` entries in the type color
  maps) are inert when this plugin is absent — same pattern as the
  `redaction` box type.
- No backend: no routes, no models, no Python logic. Removing the plugin is
  deleting this folder (plus this docs folder and its row in
  [`../README.md`](../README.md)).

## Limits

Byte-exact reading requires the document family's renderer to be modelled —
the shipped glyph sets cover the corpus families proven in char_training
(MuPDF Times/Arial/Georgia 16 px em, Courier New 13 px em, the eDiscovery
linear-compositor and palette-quantized producers, mode-2 color pages).
On an unmodelled producer the reader reports `□`s or escalates to tolerant
mode and says so in the status line — it never silently guesses. New
families are added in char_training (new glyph exports / producer laws),
then synced.
