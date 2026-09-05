# Optional Plugins

Everything in this folder documents a plugin that **Recto does not need**. The core
(`pdf_core`) and the four baseline plugins — `text_tool`, `embedded_text_viewer`,
`webgl_mask`, `extracted_text` — never reference anything documented here.

That is the contract: **this page is the only file in the guide that names an optional
plugin.** If you ever find a baseline document naming one, that's a leak worth fixing.

## Removing a plugin

Three steps, and nothing else in the repo or the guide has to change:

1. Delete the app folder (e.g. `redaction_matching/`). Plugin discovery scans the top level
   for directories containing an `apps.py`, so it simply stops being found — no `settings.py`,
   `urls.py`, or `index.html` edit.
2. Delete its docs folder (e.g. `guide/plugins/redaction-matching/`).
3. Delete its row from the table below.

Verified: with `redaction_matching` removed, `manage.py check` is clean, `GET /` returns 200,
and no candidates sidebar (`#tools-sidebar`) or its toggle button appears in the rendered
page — the panel, its CSS, and its wiring all live in the plugin.

## Auto OCR

| Plugin | Docs | What it does | Routes |
|---|---|---|---|
| `ocr_tool` | [ocr-tool/](ocr-tool/) | Byte-exact blind-reader OCR of the page rasters (client-side); certified lines land as editable `ocr` text boxes, detected redaction rectangles as `redaction` boxes. **MuPDF pixel view**: draws any text box from the reader's glyph bitmaps on mupdf's ¼-px lattice and diffs it against the page (via text_tool's `utbPixelRender` seam) | `/ocr/cache/<hash>` (precomputed startup-document read) |

- **Requires `text_tool`** (renders through the unified text box system); works with or without `embedded_text_viewer`.
- Its `engine/` + `glyphs/` static files are synced verbatim from the external `tol0` repo (`npm run sync:recto` there) — edit the engine there, never in this repo. `npm run recto-test` there smoke-tests the embedded engine and the pixel view end to end.

## Base64 attachment decoder

Finds base64 blocks (the wrapped-line body of an email attachment) in the document's
text, decodes them in the browser, sniffs the file type from the magic bytes (PDF,
PNG, JPEG, GIF, WebP, ZIP, plain text), and offers each block as a download or an
in-browser view (new tab). It reads exactly one unified-text-box layer — whichever
of OCR / embedded is visible on screen — so duplicate layers never interleave and
corrupt a block. After a document loads it waits for the text layer to settle (the
`ocr_tool` state read through a guarded global, else a stability poll), scans, and —
if attachments were found and no subtoolbar is open — opens its own bar ready for
download/view.

| Plugin | Docs | What it does | Routes |
|---|---|---|---|
| `base64_tool` | *(none yet)* | Base64 block detection → decode → typed download / in-browser view; subtoolbar UI | *(none — fully client-side)* |

- **Requires `text_tool`** (reads `utbState.boxes`; all access guarded so removal
  never throws). Needs a text source to be useful: an `ocr_tool` read or an
  `embedded_text_viewer` layer.

## Redaction matching

Candidate-name matching against redaction bars: it owns the candidates right panel (the
`#tools-sidebar` host, its toggle button, CSS, and wiring) plus the name pool, name-format
settings, and matches table. It does **not** detect bars itself — it matches names against
whatever `redaction` boxes exist on the page, so it needs a detector installed to have
anything to work on.

| Plugin | Docs | What it does | Routes |
|---|---|---|---|
| `redaction_matching` | *(none yet)* | Candidate-name → redaction-bar width matching; owns the candidates sidebar (name format, starts-with / ends-with filter, matches table) | *(none — fully client-side)* |

## Redaction refiner

Redraws detected redaction bars to the true hidden-name extent by reading the
words that surround each bar: punctuation on a neighbour abuts with no space, so
that edge is redrawn flush; a whole word (in the shipped English word list, the
candidate-name pool, or capitalised) has a real space before it, so the edge is
redrawn one space-width in; a word *fragment* (`nd` left over when the redaction
dropped the `a` of `and`) has its missing letters next to the bar, so the edge is
redrawn one space plus those letters in. Spaces and letters are sized from the
neighbour word's own font. It works from the embedded layer at once and re-derives
from the OCR words when that (slower) pass lands. No UI — it runs on the generic
`redactions:connected` PDFHooks event that `embedded_text_viewer` emits after
snapping redactions to lines.

| Plugin | Docs | What it does | Routes |
|---|---|---|---|
| `redaction_refiner` | [redaction-refiner/](redaction-refiner/) | Redraws redaction bars to the hidden-name extent via surrounding words, punctuation and a word list | *(none — fully client-side)* |

- **Attaches through the `redactions:connected` hook and guarded globals** (`renderBox`,
  `calculateAllWidths`, `getNaturalSpaceWidth`, `GEO`, `state.namesData`) — never imports.
- **Emits `redaction:refined`** (generic, names no consumer) with the remnant slivers it
  found sticking out of a bar — the hidden name's own first/last letters.
  `redaction_matching` listens and fills that box's starts-with / ends-with filter from
  them; without a refiner the event never fires and the filter stays manual.
- **Needs `redaction` boxes and surrounding text** (an `embedded_text_viewer` or
  `ocr_tool` line). With neither it no-ops. The hook emission is generic and names no
  plugin, so it stays put — emitting into the void — if the refiner is removed.

## Dependency order

```
redaction_matching ──runtime globals──> text_tool ──> pdf_core
ocr_tool           ──runtime globals──> text_tool ──> pdf_core
base64_tool        ──runtime globals──> text_tool ──> pdf_core
redaction_refiner  ──'redactions:connected'──> embedded_text_viewer ──> pdf_core
redaction_refiner  ──'redaction:refined'  ──> (redaction_matching listens, optionally)
```

- **`redaction_matching` attaches to `text_tool` through guarded globals**, not imports. See
  [the seam contract](#the-seam-contract).
- **It needs a source of `redaction` boxes.** `ocr_tool` emits them as it reads, and the
  Add-Box tool creates them manually; without either, there is simply nothing to match.
- **The Match controls** (Tolerance / Kerning / Uppercase) live in `text_tool`'s formatting
  ribbon under shared element IDs (`#tolerance`, `#kerning`, `#force-uppercase`).
  `redaction_matching` reads them if present and no-ops if not.

## The seam contract

`text_tool` is a baseline plugin and does not depend on the redaction suite. But it does
contain `typeof fn === 'function'` guarded call sites for functions that only
`redaction_matching` defines — `createNewRedaction`, `calculateWidthsForRedaction`,
`selectRedaction`, `updateAllMatchesView`, `renderCandidates`, `syncNameSettingsUI`.

These are **deliberate re-attachment seams**, and they work in both directions:

- **Plugin installed** — `api.js` is a `scripts_before_viewer` entry with no IIFE wrapper, so
  its top-level `function` declarations are true globals. The guards resolve and the call
  sites light up.
- **Plugin absent** — the guards are false and the call sites silently no-op. Nothing breaks,
  nothing is left dangling.

`text_tool` also declares a `type: 'redaction'` box variant with a few fields only this suite
populates (`widths`, `tolerance`, `nameSettings`, `candidates`). Those are inert when the
suite is absent. See [Unified Text Box](../architecture/unified-text-box.md).
