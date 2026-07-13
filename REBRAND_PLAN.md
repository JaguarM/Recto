# Recto — Rebrand & Generalization

*Epstein Unredactor* → **Recto**, an extensible PDF editor. **Done and verified.**

> **Status — superseded in part.** This is a historical record of the rebrand, kept for the
> reasoning. Two things have changed since it was written:
>
> 1. **`redaction_lab` has been removed.** Where this document describes it as a shipped,
>    verified plugin, that is no longer true. The four plugins that ship today are
>    `text_tool`, `embedded_text_viewer`, `webgl_mask`, and `extracted_text`. The removal
>    needed no change to `pdf_core` — which is exactly what section 3 predicted.
> 2. **The repository moved** to `github.com/JaguarM/Recto`.
>
> The `unbarpdf.com` CSRF origin in `settings.py` is unchanged and still deliberate.

---

## 1. The identity

**Name:** Recto — a printing term for the front (right-hand) side of a page.

**Tagline:** *An extensible PDF editor.*

> Recto is a plugin-based PDF editor built on Django. The core does one thing: it opens a
> document, renders its pages, and exposes a plugin API — a `PDFTool` registry for server-side
> tools and a `PDFHooks` event bus for the frontend. Everything else is a plugin: text editing
> with real font metrics (`text_tool`), embedded-text inspection (`embedded_text_viewer`), GPU
> region masking (`webgl_mask`), and backend extraction (`extracted_text`). Drop a folder in to
> add a tool; delete the folder to remove it.

Redaction is no longer what this project *is*. It became one plugin — and that plugin has
since been deleted, which the architecture absorbed without a single change to the core.

| Was | Is |
|---|---|
| `epstein_project/` | `recto/` |
| `guesser_core/` | `pdf_core/` |
| *(redaction engine inside the core)* | `redaction_lab/` → **since removed** |
| `assets/names/epstein_names.json` | **deleted** |
| `text_tool/`, `embedded_text_viewer/`, `webgl_mask/`, `extracted_text/` | unchanged |

---

## 2. What made this cheap: most of it was dead

The name-guessing layer had already been half-removed by an earlier refactor. `addName()`,
`updateAllMatchesView()`, `selectRedaction()`, `renderCandidates()`, `syncNameSettingsUI()`,
and `calculateWidthsForRedaction()` were **called but never defined** — every call site was
`typeof`-guarded, so they silently no-opped. The state feeding them was written and never
read; the DOM they'd have driven existed in no template; `epstein_names.json` was fetched by
nothing.

So the Epstein-specific machinery was **deleted, not migrated**.

`text_tool` still contains the guarded call sites. They are left deliberately as inert
re-attachment seams: reinstall a matching plugin that defines those globals and they light up
again. See `guide/frontend/api-and-logic.md`, which now documents that plugin as a spec rather
than as shipped code.

---

## 3. The structural fix

`guesser_core` was not a core. It was a viewer shell and a redaction engine fused together,
and **`POST /analyze-pdf` was the only way to open a document** — every upload ran black-bar
detection before a page could render. A general PDF editor cannot have that.

Ingestion is now split along the seam:

```
POST /open-document        (pdf_core)        POST /redaction/analyze   (redaction_lab)
  page_images                                  redactions[]
  page_image_type
  page_width, page_height
  num_pages
  spans          ← embedded text, generic
  pdf_fonts      ← font inventory, generic
  suggested_scale, suggested_size
```

The core opens the document, emits `document:loaded`, and stops. `redaction_lab` subscribes,
re-posts the file to its own endpoint, and adds its boxes on top. **The core contains no
reference to redaction.**

- `ProcessRedactions.py` split into `pdf_core/logic/document_loader.py` (render + spans + fonts) and `redaction_lab/logic/detect.py` (boxes). Both analyse the same rasters via the shared `iter_page_rasters()`, so plugin coordinates line up with the rendered page.
- `BoxDetector.py`, `SurroundingWordWidth.py`, `refiners/` moved into the plugin.
- `masking.py` moved into `webgl_mask` — its only consumer.
- `geometry.py` stayed in core (`text_tool` depends on it).
- New generic `ribbon_bar` slot on `PDFTool`. The redaction-specific "Match" bar (tolerance / kerning / uppercase) moved out of the core template into `redaction_lab`. Ribbon ordering moved from core CSS into each plugin's own stylesheet, so the core no longer names a plugin's bar.

**Known cost:** the file is parsed twice — once to render, once to detect. Both endpoints stay
stateless, which is worth it. If it ever bites, have `/open-document` cache the upload and
return a `doc_id` that `/redaction/analyze` takes instead of the raw file.

**Behaviour change:** `suggested_scale` is now derived even on documents with no redaction
bars. Previously it was only computed inside the box-detection branch and fell back to a
constant. This is strictly more correct and was necessary once the core stopped detecting.

---

## 4. Verified

Driven against a live server, not just imports:

- `manage.py check` clean; all Python compiles; zero tracebacks in the server log.
- `GET /` → 200, title is `Recto — PDF Editor`, ribbon and plugin script present.
- `GET /open-default` → 200; 1 page, 26 spans, scale 133, size 12.0. **`redactions` key absent from the core payload.**
- `GET /redaction/analyze-default` → 200, 3 boxes.
- `POST /open-document` + `POST /redaction/analyze` → 200 for both PDF and image uploads; a generated PNG with two bars drawn at known coordinates came back detected at those coordinates.
- **Deletability, the load-bearing claim:** with `redaction_lab/` moved away, the app still boots, still opens documents (1 page, 26 spans), `/redaction/*` correctly 404s, and the Match bar and plugin script vanish from the HTML — with zero errors. Restored afterwards; all green.

Zero occurrences of `epstein` / `unredactor` / `guesser` remain anywhere in the tree. The one
exception is the toolbar's GitHub link to `github.com/JaguarM/EpsteinTool`, and the
`unbarpdf.com` CSRF origin in settings — both kept as-is at your request.

> **Since updated:** the toolbar link now points at `github.com/JaguarM/Recto`, and `setup.sh` /
> `run_app.sh` have been de-branded (`/var/www/recto`, `recto.service`). The `unbarpdf.com` CSRF
> origin still stands.

---

## 5. Left open

- **The editor gap you named:** embedded text can be viewed but not saved. That's now a plugin-shaped hole — `pdf_export/`, `POST /export`, taking the original PDF plus `utbState.boxes` and writing text back with PyMuPDF (`page.insert_text`). The box model already carries everything it needs: font family, size in points, position in document space, kerning.
- The `tool-add-box` button ("Add Redaction Box") still lives in `text_tool` and `embedded_text_viewer` option bars, and still creates a `type: 'redaction'` box. With `redaction_lab` gone there is nowhere to move it to, so it should be generalized into an untyped box tool. **This is now the most visible loose end:** `inline-edit.js` refuses to edit `redaction` boxes (the match engine used to own their text), so the box this button creates can no longer be given text by any means.
- Deployment docs say `recto` for the systemd unit and `/var/www/recto`, and `setup.sh` now matches. **An already-deployed server still running `epsteintool.service` will not be touched by the renamed script** — rename the unit, or re-run `setup.sh`, when convenient.
