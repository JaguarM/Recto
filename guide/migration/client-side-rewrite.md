# Client-side rewrite — the plan

Branch: `client-side-rewrite`. Goal: Recto as a **static website**. Every
piece of work the Django server does today moves into the browser
(JavaScript, plus MuPDF and HarfBuzz as WebAssembly). When the last phase is
done the result is copied into a new repository; `main` stays the Django
version and is never touched from this branch.

This file is the single source of truth for the work. It is written for a
fresh session that has not seen the conversation that produced it. Keep the
**Progress** checklist at the bottom current: tick a phase only when its
acceptance criteria pass, and write down anything a later phase must know.

## Why

Django is not slow. The cost is that the *server* does PDF work on every
request: `/page-image` reopens the PDF and re-encodes a PNG each time, and
text extraction runs per page. Measured 2026-09-18 on the same documents
(`reference/bench-reference.js`, numbers below), the same work in the browser
is 5–10× cheaper per page and costs the server nothing. The target server is
cheap hardware, so the fix is to stop sending it work — not to swap the web
framework.

| | browser: MuPDF 1.28 as WebAssembly, in a worker | Django dev server, same machine |
|---|---|---|
| start-up | wasm init 48 ms, heap 22 MB | — |
| open 5 p / 25 p / 340 p (66 MB) / 943 p | 4 / 1 / 34 / 6 ms | 136 / 660 / 910 / 310 ms |
| scanned page: decode the embedded raster | 2.6–2.9 ms | 25–39 ms per `/page-image` |
| vector page: render at 96 dpi | 5–25 ms (worst court page 186 ms) | 31 ms (worst 160 ms) |
| one page's text with per-character positions | 1.3–5.5 ms | 15–28 ms |
| every page of the 340-page scan: raster + text | 2.7 s | text scan alone: 7.0 s of server CPU |

Memory: the wasm heap is file size + 22 MB after open, about 100 MB after
browsing a 66 MB file, and bounded near file size + 280 MB (MuPDF's cache is
capped at 256 MB). A wasm heap never shrinks; terminating the worker frees it
(re-init 48 ms + reopen 34 ms). MuPDF's JS wrappers (`Image`, `Pixmap`, `Page`,
`StructuredText`) must be `destroy()`ed explicitly — left to GC they held
~250 MB extra in the benchmark.

## What must not be lost

1. **Drag-in / drag-out plugins.** Every feature beyond the core is a
   self-contained folder; deleting the folder removes the feature with no
   dangling reference, dropping one in adds it. This is the project's most
   valued property (it also keeps AI context small). It survives as: one
   `plugin.json` per folder + a scan step (below).
2. **The core runs no analysis** and never calls a plugin by name; plugins
   attach through the `PDFHooks` bus and `typeof`-guarded globals. Baseline
   code and docs never name an optional plugin.
3. **The coordinate contract** (`geometry.py` ↔ `geometry.js`): image px at
   96 DPI for geometry, PDF points for typography, converted once.
4. **Pixel exactness.** The OCR reader and pixel view certify against page
   bytes. Page rasters must stay byte-identical to what the server produced
   (same crop, lossless). The engine under
   `ocr_tool/static/ocr_tool/engine/` is synced verbatim from `../tol0` and is
   not edited here.
5. **No bundler, no runtime package manager.** Plain scripts, loaded in a
   fixed order. One zero-dependency Node script may generate `index.html`;
   nothing is transpiled or bundled.
6. **Privacy by construction.** A user's document never leaves the browser.

## Inventory — what the server does today

Server calls made by the frontend, and what replaces each:

| Call | Made by | Server work | Replacement |
|---|---|---|---|
| `POST /open-document` | `pdf_core/pdf-viewer.js` | store upload by sha256, `load_pdf_meta` (pages, page px size, fonts most-used first, suggested scale and body size) / `load_image_meta` | `crypto.subtle.digest` for the hash; metadata from the MuPDF worker; the `File` stays in memory |
| `GET /open-default` | `pdf_core/app.js` | serve the PDF in `assets/pdfs/` | static fetch of the file named in a generated manifest |
| `GET /page-image/<hash>/<n>` (+`?thumb=1`) | `pdf-viewer.js` (`state.pageImages[n]` → `img.src`) | `_first_raster` + `crop_to_page_ratio` (embedded raster, cropped) or a 96-dpi render → PNG | worker: same raster, same crop, PNG via MuPDF → `blob:` URL, created lazily per page and revoked when evicted |
| `GET /embedded-text-viewer/api/extract-spans` | `etv-fetch.js` (lean 200-page chunks + one full page) | `extracted_text/logic/extract.py` | the plugin's own JS port of `extract.py` over the core's raw structured-text primitive |
| `POST /widths` | `text_tool/toolbar.js`, `redaction_matching/api.js` (many strings per call) | HarfBuzz shaping (`text_tool/logic/width_calculator.py`) | HarfBuzz as WebAssembly (harfbuzzjs), same library ⇒ same numbers |
| `GET /font-metrics` | `text_tool/fonts.js` | HarfBuzz advances + kern pairs at a size (`font_metrics.py`) | same, via harfbuzzjs |
| `GET /fonts-list` | `text_tool/fonts.js` | `assets/fonts/fonts.json` + which files exist | generated static JSON (the scan step writes the `present` map) |
| `GET /webgl/mask/<hash>/<n>` | `webgl_mask/webgl-mask.js` | OpenCV black-region mask (`masking.py`, `artifact_visualizer.py`) | JS port in the plugin's own worker |
| `GET/PUT /ocr/cache/<hash>` | `ocr_tool/ocr-tool.js` | JSON file per document | IndexedDB; prebuilt JSON shipped as static files for bundled documents |
| static: glyph bundle, engine, `names.json`, fonts | several | none | unchanged static files |

Python that is **not** ported (dead for the app — verify with grep before
deleting): `extracted_text/logic/calibrate.py`, `pdf_core/logic/{shaper,
line_breaker,layout_calculator}.py`, `pdf_core/management/commands/
measure_text.py`, the duplicate `width_calculator.py` copies in
`extracted_text` and `embedded_text_viewer`, every `models.py` / `admin.py` /
`migrations/` (empty), `document_store.py` eviction, `demo/` (a separate
Django demo project — out of scope, stays on `main`), `setup.sh`,
`run_app.bat`. `redaction_refiner/words_build.py` is a build-time word-list
script: keep it as a dev script.

Size of the job: about 7,700 lines of plugin/core JS already exist and mostly
move unchanged; about 2,900 lines of Python exist, of which roughly 1,300 are
live and need a JS equivalent (`document_loader.py` 317, `extract.py` 434,
`masking.py` + `artifact_visualizer.py` 292, width/metrics ~230).

## Target layout

Everything the static site serves lives under `web/`. Django apps stay in
place until Phase 8 so `main`-equivalent behaviour remains runnable on this
branch for comparison.

```
web/
  index.html                 GENERATED — never edited by hand
  core/                      was pdf_core/static/pdf_core  (+ index.template.html)
    doc-service.js           the ONLY thing that knows about the worker
    pdf-worker.js            module worker: MuPDF, the open document
  plugins/
    text_tool/               plugin.json + *.html fragments + js + css
    embedded_text_viewer/    (contains the extract.py port)
    webgl_mask/  ocr_tool/  redaction_matching/  redaction_refiner/  base64_tool/
  vendor/
    mupdf/                   mupdf.js, mupdf-wasm.js, mupdf-wasm.wasm  (1.28.0, pinned)
    harfbuzz/                hb.wasm + hbjs.js                          (pinned)
  assets/
    fonts/  pdfs/            moved from assets/
  generated/
    plugins.json  fonts.json  default-document.json
tools/
  build.mjs                  zero-dependency: scan web/plugins/*/plugin.json → index.html + generated/*
  serve.mjs                  dev server: static files, correct MIME, COOP/COEP, runs build on each index request
  golden/                    scripts that record the Django version's outputs (Phase 0)
tests/
  golden/                    recorded outputs (JSON / PNG), small
  *.test.mjs                 node:test suites against the goldens
```

### `plugin.json` — the static `tool.py`

```json
{
  "name": "text_tool",
  "order": 20,
  "styles": ["styles.css"],
  "toolbar_button": "toolbar_button.html",
  "options_bar": "options_bar.html",
  "ribbon_bar": null,
  "sidebar": null,
  "scripts_before_viewer": [],
  "scripts_after_app": ["fonts.js", "unified-text-box.js", "svg-renderer.js"]
}
```

Same slots as `pdf_core/base.py PDFTool`. `tools/build.mjs` inlines the HTML
fragments into `core/index.template.html` at the same four insertion points
the Django template has (styles, toolbar buttons, options/ribbon bars,
sidebars) and emits `<script>` tags in today's order: `hooks.js` →
`geometry.js` → `state.js` → plugins' `scripts_before_viewer` →
`pdf-viewer.js` → `ui-events.js` → `app.js` → plugins' `scripts_after_app`.
Cache-busters become the first 8 hex digits of each file's sha256 (no more
hand-bumped `v=` numbers). A static host cannot list directories, so the scan
runs when the dev server serves `index.html` and once at deploy — the same
moment Django's autodiscovery runs today. Template tags in fragments
(`{% static %}`) become relative paths.

### The document service (the one new core concept)

`core/doc-service.js` replaces every document endpoint with an async API and
is the only file that talks to `pdf-worker.js`:

```js
Doc.open(fileOrArrayBuffer, name) → { sha256, numPages, pageWidth, pageHeight, pdfFonts, suggestedScale, suggestedSize, pageImageType }
Doc.pageImageURL(n, { thumb })    → Promise<string>   // blob: URL of a lossless PNG; LRU of ~24 pages, revoked on eviction
Doc.structuredText(n)             → Promise<object>   // RAW MuPDF stext for one page: blocks/lines/spans/chars, quads, font, size, flags
Doc.pageImageRect(n)              → Promise<rect|null> // where the embedded raster sits on the page (extract.py needs it)
Doc.bytes()                       → ArrayBuffer        // for a plugin that runs its own worker
Doc.close()
```

`state.docHash` keeps its meaning (sha256 of the file). `state.pageImages`
stops being an array of URLs: `pdf-viewer.js` asks `Doc.pageImageURL(n)` when
it needs a page. The core still runs **no analysis** — `structuredText` is a
primitive, turning it into spans is the text plugin's job. Worker rules: one
module worker owns MuPDF and the document; every wrapper is `destroy()`ed;
the worker is terminated and recreated on `Doc.close()` so memory returns.
`reference/mupdf-worker-reference.js` is a working worker from the benchmark
(open, embedded-raster decode, 96-dpi render, text walk, heap reporting) —
start from it.

## Phases

Each phase ends with a commit on this branch. Do them in order; every phase
leaves the static site runnable.

### Phase 0 — goldens from the Django version (before anything moves)

Record what the server returns today, so every port can be checked without
running Django again. Create `.venv` (`python3 -m venv .venv &&
.venv/bin/pip install -r requirements.txt`; `.venv/` is gitignored).

Documents: `assets/pdfs/*.pdf` (startup, 5 p), `demo/samples/EFTA00382083.pdf`
(25 p, all pages), `demo/samples/EFTA01011184.pdf` (340 p — pages 1, 2, 3, 85,
170, 255, 340 only), one generated **vector** PDF (write it with PyMuPDF in
the golden script: two pages, Times/Helvetica/Courier base-14 text, a filled
black rectangle, mixed sizes — deterministic), and one PNG and one JPG image
document.

Record into `tests/golden/<doc>/`: the `/open-document` JSON; per page the
sha256 of the `/page-image` PNG's **decoded pixels** plus width/height (not
the PNG bytes — encoders differ); `/extract-spans` JSON, both `lean=1` and
full; the mask PNG's decoded-pixel hash and the JSON around it;
`/fonts-list`; `/font-metrics` for Times New Roman, Arial, Courier New,
Nimbus Roman at 16 px and 13.3333 px, regular and bold; `/widths` for a fixed
list of 200 strings (names from `redaction_matching`'s `names.json`, with
kerning on and off, uppercase on and off, two scales).

Acceptance: `tools/golden/record.py` regenerates the folder byte-identically
twice in a row; total size under 5 MB.

### Phase 1 — skeleton: `web/`, `plugin.json`, build and dev server

`git mv` each app's `static/<app>/` to `web/plugins/<app>/` and
`pdf_core/static/pdf_core/` to `web/core/`; move templates' fragments next
to them; write each `plugin.json` from its `tool.py`; move `assets/` to
`web/assets/`. Write `tools/build.mjs` and `tools/serve.mjs`
(`reference/static-server-reference.py` shows the headers and MIME types
needed). Absolute `/static/<app>/…` URLs inside JS and CSS become relative to
the plugin.

Acceptance: `node tools/serve.mjs` serves an `index.html` whose script order
and DOM match the Django-rendered page (diff the two after normalising
URLs); moving a plugin folder out of `web/plugins/` and reloading removes its
button, bars, scripts and styles with no console error, and moving it back
restores them. Nothing opens a document yet.

### Phase 2 — documents and pages without a server

Vendor MuPDF 1.28.0 into `web/vendor/mupdf/`. Write `pdf-worker.js` and
`doc-service.js`. Port `document_loader.py`: `load_pdf_meta` (including the
font usage count and `_suggested_size` / `_span_size` — bbox height over
ascender − descender), `load_image_meta`, `_first_raster`,
`crop_to_page_ratio` (exact integer arithmetic — coordinates depend on it),
the 96-dpi fallback render, thumbnails. Switch `pdf-viewer.js` and `app.js`
to `Doc`. Image documents (PNG/JPG) go through `createImageBitmap`.

Acceptance: for every golden page, decoded pixels hash-equal the golden;
open metadata equals the golden JSON; the 340-page sample opens in under
200 ms and the 943-page court bundle scrolls without the heap exceeding file
size + 300 MB (log `HEAPU8.buffer.byteLength` from the worker); closing a
document returns the worker's memory.

### Phase 3 — embedded text

Port `extracted_text/logic/extract.py` to
`web/plugins/embedded_text_viewer/extract.js` over `Doc.structuredText`.
PyMuPDF's `rawdict` and mupdf.js's structured text expose the same data with
different shapes — write one adapter, then port the logic line for line
(space handling, `_span_size_pt`, the page-image rect transform, the lean
variant). Keep the chunked, abortable scan the viewer does today.

Acceptance: spans deep-equal the goldens (numbers within 1e-6) for every
golden page, lean and full; the whole-document scan of the 340-page sample
finishes in under 5 s without blocking the UI.

### Phase 4 — text measurement

Vendor harfbuzzjs. `web/plugins/text_tool/shaping.js` replaces `/widths`
and `/font-metrics` (same request objects in, same response objects out, so
callers change one line). Fonts are fetched once per face and cached. The
font catalogue (`fonts.json` + `present`) is written by the build.

Acceptance: `/widths` and `/font-metrics` goldens reproduce exactly (same
HarfBuzz ⇒ equal to the last printed digit; if the vendored version differs
from Python's `uharfbuzz`, state the versions and the largest difference
found); a redaction box with 688 candidates measures in under 300 ms.

### Phase 5 — masks

Port `webgl_mask/logic/masking.py` + `artifact_visualizer.py` to a worker in
the plugin. Threshold, dilation, connected components and the edge-line rule
are plain loops. `_remove_circles` uses OpenCV's `HoughCircles`: first try a
component-shape test (bounding box near square, fill ratio near π/4); if the
goldens cannot be met that way, lazy-load opencv.js **inside this plugin
only** and say so in its README.

Acceptance: mask pixels equal the goldens on every golden page, or every
differing page is listed with a picture and a reason.

### Phase 6 — OCR cache and the remaining plugins

`ocr_tool`: replace `/ocr/cache/<hash>` with IndexedDB (same JSON, same
version checks); ship the two committed cache files as static
`web/plugins/ocr_tool/cache/<hash>.json` and read those first.
`redaction_matching`, `redaction_refiner`, `base64_tool`: no server logic —
fix paths only. Update `../tol0/tools/sync-recto.mjs` for the new engine and
glyph locations and for hash busters coming from the build instead of
`tool.py` (that is a change in the tol0 repository; commit it there
separately).

Acceptance: the startup document reads from the shipped cache with no
network call other than static files; a second document reads, caches, and
re-opens from IndexedDB; `PixelView.verdict(page)` reports the same certified
and exact counts as on `main` (startup document: 308 certified lines, all
exact); `npm run recto-test` in tol0 passes against `tools/serve.mjs`.

### Phase 7 — tests and docs

Port the Python tests that still mean something to `node:test` suites under
`tests/` (goldens make most of them one-liners); keep the existing
`tests_js`. Add a browser smoke test with tol0's puppeteer-core harness: open
each golden document, select a box, toggle every toolbar setting, enable the
pixel view, assert no console error. Rewrite `CLAUDE.md`, `guide/architecture/
*`, `guide/tool-expansion-guide.md`, `guide/api-reference` (now the `Doc` API
and `plugin.json`), `guide/ui-map.md` paths.

Acceptance: `node --test tests/` passes; the smoke test passes; no document
in `guide/` mentions Django, `tool.py`, `manage.py` or an HTTP endpoint that
no longer exists.

### Phase 8 — remove Django, prepare the new repository

Delete every Django app's Python, `recto/`, `manage.py`, `requirements.txt`,
`setup.sh`, `run_app.bat`, `demo/` (they remain on `main`). Add a deploy note:
any static host; serve `.wasm` as `application/wasm`; long cache lifetimes
are safe because every URL carries a content hash; COOP/COEP headers are
optional. Write `MIGRATING.md` for the new repository (what changed for
plugin authors: `tool.py` → `plugin.json`, endpoints → `Doc`).

Acceptance: a clean clone plus `node tools/build.mjs` plus any static file
server runs the whole app; repository size and the list of vendored binaries
(MuPDF wasm ~10 MB, HarfBuzz wasm ~1 MB, glyph bundle ~12 MB, fonts ~24 MB)
are stated in the README. The user then creates the new repository from this
tree.

## Rules for the session doing the work

- Read `CLAUDE.md`, this file, then `guide/architecture/architecture-overview.md`
  and `guide/tool-expansion-guide.md` before writing code.
- One phase at a time, one or more commits per phase, never commit to `main`.
- A port is done when its goldens pass, not when it looks right. Where a
  golden cannot be met, write down the page, the difference and the cause.
- Do not edit files under `engine/` or `glyphs/` — they are synced from
  `../tol0`. Never run tol0's sync with `--allow-partial`.
- Do not name an optional plugin in core code or core docs.
- Keep `destroy()` discipline in every worker; check the heap after each
  phase on the 340-page sample.
- Licensed Windows fonts live in `assets/fonts/` today and are served
  publicly already; before the new repository is made public, ask the user
  which fonts may be redistributed.

## Open decisions (ask the user when the phase arrives)

1. Phase 2: keep opened documents across reloads (OPFS / IndexedDB), or
   reopen from disk each time? Default: reopen — nothing is persisted.
2. Phase 5: is circle rejection in the mask worth an 8 MB opencv.js if the
   shape test cannot match it?
3. Phase 8: which fonts ship in the public repository.

## Progress

- [ ] Phase 0 — goldens
- [ ] Phase 1 — skeleton, `plugin.json`, build, dev server
- [ ] Phase 2 — documents and pages
- [ ] Phase 3 — embedded text
- [ ] Phase 4 — text measurement
- [ ] Phase 5 — masks
- [ ] Phase 6 — OCR cache, remaining plugins, tol0 sync
- [ ] Phase 7 — tests and docs
- [ ] Phase 8 — remove Django, prepare the new repository

Notes for later phases (append as you learn):

- (none yet)
