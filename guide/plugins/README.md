# Optional Plugins

Everything in this folder documents a plugin that **Recto does not need**. The core
(`pdf_core`) and the four baseline plugins — `text_tool`, `embedded_text_viewer`,
`webgl_mask`, `extracted_text` — never reference anything documented here.

That is the contract: **this page is the only file in the guide that names an optional
plugin.** If you ever find a baseline document naming one, that's a leak worth fixing.

## Removing a plugin

Three steps, and nothing else in the repo or the guide has to change:

1. Delete the app folder (e.g. `redaction_lab/`). Plugin discovery scans the top level for
   directories containing an `apps.py`, so it simply stops being found — no `settings.py`,
   `urls.py`, or `index.html` edit.
2. Delete its docs folder (e.g. `guide/plugins/redaction-lab/`).
3. Delete its row from the table below.

Verified: with all three redaction plugins removed, `manage.py check` is clean, `GET /`
returns 200, `/redaction/*` correctly 404s, and no redaction markup appears in the rendered
page. Mind the dependency order below when removing more than one.

## Auto OCR

| Plugin | Docs | What it does | Routes |
|---|---|---|---|
| `ocr_tool` | [ocr-tool/](ocr-tool/) | Byte-exact blind-reader OCR of the page rasters (client-side); certified lines land as editable `ocr` text boxes, detected redaction rectangles as `redaction` boxes | *(none — fully client-side)* |

- **Requires `text_tool`** (renders through the unified text box system); works with or without `embedded_text_viewer`.
- Its `engine/` + `glyphs/` static files are synced verbatim from the external `char_training` repo (`npm run sync:recto` there) — edit the engine there, never in this repo. `npm run recto-test` there smoke-tests the embedded engine end to end.

## The redaction suite

Three plugins that together restore the original black-bar analysis feature. They are
independent Django apps, but they are **not independent of each other** — see the dependency
note below.

| Plugin | Docs | What it does | Routes |
|---|---|---|---|


## Dependency order

```
redaction_refiner ──hard import──> redaction_lab ──> pdf_core
redaction_matching ──runtime globals──> text_tool ──> pdf_core
```

- **`redaction_refiner` requires `redaction_lab`.** It imports `redaction_lab.logic.refiners.*`
  directly, so removing `redaction_lab` while `redaction_refiner` is installed is an
  `ImportError` at startup. Remove the refiner first, or remove both together.
- **`redaction_lab` does not require `redaction_refiner`.** `detect.py` builds its pipeline
  from `RefinerRegistry.build_pipeline()`, so with no refiners registered the registry is
  empty and boxes pass through unrefined rather than crashing.
- **`redaction_matching` attaches to `text_tool` through guarded globals**, not imports. See
  [the seam contract](#the-seam-contract).

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
