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
cancels the old run (the page in flight is abandoned at its next band)
before the new auto read starts. Manual runs never flip layers.

This matters for scanned/eDiscovery documents: their pages are images, so the
embedded-text extractor has nothing to read. The blind reader recovers the
text from the pixels — *certified, not guessed*: a line is byte-clean only
when its glyphs reproduce the page bytes exactly through the producer's
proven blend law; anything unexplained is an honest `□`.

## Precomputed cache for the startup document

The **startup document** (the PDF in `assets/pdfs/`, auto-loaded on open) is
the one document every visitor sees, so its auto-read is precomputed instead
of re-run in every browser:

- After a full engine read of the startup document, the adapter slims each
  page's result down to exactly the fields `ocrAddBoxes` consumes and POSTs
  them to `/ocr/cache/<sha256>` (the document hash the core returns as
  `state.docHash`). The backend (`views.py`) stores it as
  `ocr_tool/cache/<sha256>.json` — **dev only**; in production the endpoint
  answers 403 so nobody can overwrite what visitors see.
- On load, the auto-read first GETs that URL. A hit replays the boxes through
  the normal `ocrAddBoxes` path — no engine, no ~10 MB glyph download — and
  the status line ends in `precomputed`. A miss falls back to the live engine
  read (unchanged behaviour).
- The cache files are **committed**: swap the startup PDF, open the app
  locally once, let the auto OCR finish, commit the new JSON. Re-running
  **All pages** on the startup document refreshes it (e.g. after an engine
  re-sync), and tol0's `node tools/recto-cache.mjs` does the same headless.
  `version` (`OCR_CACHE_VERSION`, currently 2: per-page `spaceAdv`, per-line
  `phy`, per-entry `src`) guards the payload shape.
- **Uploaded documents never touch the cache** — deliberately, so
  char_training's `npm run recto-test` (which uploads its certified document
  and waits for the auto cycle) always exercises the real engine, and a
  DEBUG-mode test run can't self-poison a later one.

## The engine is developed elsewhere

`static/ocr_tool/engine/` (`core.js`, `ocr.js`, `ocr-engine.js`, `blindocr.js`,
`render.js`) and `static/ocr_tool/glyphs/` are **verbatim copies** from the
external `tol0` repo (`Desktop/tol0`, the certified port of the older
`char_training`), where the reader is developed and certified against a
multi-document corpus gate. **Never edit those copies
here.** The workflow:

1. Edit the engine in `tol0`, run its tests and certifications (`npm test`,
   `npm run certify:ftclone`, `npm run certify:render`) and its gate.
2. `npm run sync:recto` there — copies the engine + glyph sets in and rewrites
   the cache-buster hashes in this plugin's `tool.py`.
3. `npm run recto-test` there — headless end-to-end smoke: boots this Django
   app, runs Auto OCR on the bundled default document, asserts byte-clean
   boxes. (`npm run sync:recto -- --check` reports staleness without writing.)

Only `ocr-tool.js` (the adapter: UI wiring, page-raster → engine buffer,
lines → UnifiedTextBoxes), `ocr-worker.js` (the Worker the adapter reads
in), `ocr-result.js` (the slim result shape shared by the worker, the cache
and `ocrAddBoxes`) and `pixel-view.js` (the MuPDF pixel view) are owned by
this app and edited here.

## How it reads

- **Off the main thread.** The engine is synchronous JavaScript that yields
  only between bands, and a page in a face the sets do not carry runs the
  whole tolerance ladder — tens of seconds with the full bundle. The adapter
  therefore builds the page buffer (canvas → gray, colour whitening — that
  part needs the DOM) and posts it to a dedicated Worker, `ocr-worker.js`,
  which imports the same engine scripts the page loaded (their cache-busted
  URLs, so it can never run a stale copy), loads the glyph bundle once, and
  returns the **slim** result (`ocr-result.js`) — the shape the precomputed
  cache stores, replayed through the same `ocrAddBoxes`. Zooming, page
  changes and editing stay live while a read runs. The main thread loads the
  glyph sets only for the pixel view, or to read inline in a browser without
  Workers (the fallback, same results). **Stop** cancels between bands: the
  page in progress is abandoned (no boxes for it), earlier pages keep theirs;
  loading another document does the same before its own auto read starts.
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
- Backend: only the precomputed-OCR cache route (`/ocr/cache/<hash>`,
  `views.py`/`urls.py`, storage in `ocr_tool/cache/`) — no models. Removing
  the plugin is still just deleting its folder (the cache lives inside it),
  plus this docs folder and its row in [`../README.md`](../README.md).

## Limits

Byte-exact reading requires the document family's renderer to be modelled —
the shipped glyph sets cover the corpus families proven in char_training
(MuPDF Times/Arial/Georgia 16 px em, Courier New 13 px em, the eDiscovery
linear-compositor and palette-quantized producers, mode-2 color pages).
On an unmodelled producer the reader reports `□`s or escalates to tolerant
mode and says so in the status line — it never silently guesses. New
families are added in char_training (new glyph exports / producer laws),
then synced.

## MuPDF pixel view

Two toggles in the **MuPDF view** group of the OCR bar (`pixel-view.js`):

| Tooltip | id | What it does |
|---|---|---|
| Show text as MuPDF pixels | `ocr-pixel-view` | Every text box is drawn from the reader's own glyph bitmaps on mupdf's ¼-px pen lattice and whole-pixel baseline, instead of SVG text — the raster mupdf would have produced. Tinted like the SVG text (alpha = ink darkness); pixelated when zoomed. |
| Highlight pixels that differ from the page | `ocr-pixel-diff` | Matching ink pixels go faint, pixels whose predicted byte differs from the page turn solid red, and page ink inside the line's band that no drawn glyph explains turns solid orange (the reader's residual — a quote mark it never transcribed). The status line reports `OCR lines n/m exact` (reader-certified lines, which must all be exact — within the reader's own ±tol when a line was read on a tolerant rung) and `other boxes n/m exact` (embedded / hand-added text, compared but not expected to match) for the page and, on selection, the box's ink-pixel and differing-pixel counts. |

- **Which glyph set draws a box.** OCR lines: the set the reader picked
  (`box.ocr.font`; a union name resolves per glyph through
  `baseCharPositions[i].src`). Other boxes (embedded, hand-added): the
  shipped set whose family, bold/italic and pixel size match
  (`sizePt × px/pt`, within 0.02 px). No match → the box stays SVG and the
  status line names the missing set.
- **The reader's own terms.** An OCR line is re-drawn with the y-phase
  records the reader pinned it to (`box.ocr.phy`, 0.5 on the legacy sets
  that carry ½-phase rasters) and judged at the tolerance of the rung it was
  read on (`box.ocr.tol`: byte-exact at 0; |Δ| ≤ tol, 2·tol on composite
  pixels, otherwise — scanLine's rule). "Exact" in the status line means
  exact to that standard.
- **Both halves of the certificate.** The renderer proves one direction:
  every drawn pixel is the page. The reader proves the other: no ink in the
  band was left unexplained (`box.ocr.residual`, its own residual count —
  `clean` means no failure columns and residual 0). "Exact" needs both. For a
  line the reader marked unclean (orange text), the Diff locates the leftover
  ink with `render.js residualInk` (page ink in the reader's judged rows that
  no drawn glyph covers, outside the object mask and the detected redaction
  rectangles) and paints it orange; the status line quotes the reader's own
  count. The location is a rebuild of the reader's bookkeeping and can differ
  by a few fringe pixels around a redaction box; the count is the reader's.
- **Pens.** Measured pens (plus nudges and space overrides) when the box has
  per-character positions; otherwise a fresh layout from `box.x` through
  `render.js layoutLine` with the set's advances. Spaces use the reader's
  page-calibrated space (`box.ocr.spaceAdv`, also stored in the slim cache,
  payload version 2) or an approximate per-family em fraction.
- **Diff compares against the reader's page**: the viewer's `<img>` through
  `PageEngine` + `whitenColored`, through the page's palette map when the
  line was read with a palette pass, and never under the reader's object
  mask or box halos (`render.js objectMask`: `detectObjects` plus the ±2-column,
  ±3-row halo around every redaction box, where the reader forgives clipped
  glyph fragments; a descender dipping into a box's padding or a glyph
  half-swallowed by the redactor is reported as "under a box/rule", not as a
  difference) — so zero differing pixels means the same thing as
  the reader's byte-clean. Hidden layers (`hide-ocr-text` /
  `hide-embedded-text`) are not drawn or counted.
- **Honest limits.** A character the set lacks, a set that is not loaded, or a
  page raster that is not 1:1 with the viewBox → SVG fallback, never an
  approximation. The seam is `window.utbPixelRender` in `svg-renderer.js`
  (see [Unified Text Box](../../architecture/unified-text-box.md)).
- **Proofs.** tol0: `npm run certify:render` (render.js vs real mupdf at every
  1/64 pen phase, both TTF and CFF pipelines, forced overlaps — 0 diffs),
  `npm test` (synthetic round trip render → readPage → clean). Recto:
  `python manage.py test ocr_tool`. Browser: tol0's `npm run recto-test`
  asserts every byte-clean OCR box reports 0 differing pixels; its
  `tools/verify-recto-pixels.mjs` runs the same check over a folder of PDFs.
  Design record: [pixel-view-plan.md](pixel-view-plan.md).

## Faces: `engine/set-fonts.js` and the toolbar default

Every glyph set names the face it was rendered from in `engine/set-fonts.js`,
generated in tol0 from the registry's PROVENANCE (`npm run set-fonts`, asserted
current by `npm test`, synced with the engine): `{ family, bold, italic, file,
sizePx, plain }`, or `null` for page-cut sets. Family names are the text tool's
catalogue names, so a line read with `nimbus791` is a `Nimbus Mono PS` box and
the browser draws its vector text from the URW file itself.

- `ocrAddBoxes` sets each segment's family/bold/italic from the set that drew
  most of its glyphs (per-glyph `src` on union lines), through
  `ocrFontFromSetName`.
- When a read finishes (live or replayed from the cache) the adapter emits
  `typography:detected { fontFamily, sizePt, source: 'ocr' }` with the
  dominant face and size of the certified lines (weighted by glyph count);
  `text_tool`'s `fonts.js` selects it in the font menu and size input.
- The pixel view picks the glyph set for a hand-typed box by family and size
  through the same table (`plain` sets only — stock face, stock law).
