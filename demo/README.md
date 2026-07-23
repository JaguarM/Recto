# Recto Demo — "Watch OCR find your attachments"

A small standalone showcase app living inside the Recto repo. One task only:
open a scanned-email PDF, watch the client-side OCR read it (live progress
pill + page shimmer + line highlights), and get any base64 email attachments
as View/Download cards the moment they're found — attachments surface
incrementally *while* OCR is still running, with multi-page attachments shown
as a "still reading…" partial card until their last page is read.

## Run

```bash
python demo/manage.py runserver 5001    # → http://localhost:5001
python demo/manage.py test viewer       # backend tests
```

Requirements are the same as Recto's (`requirements.txt` at the repo root —
Django, PyMuPDF, Pillow).

## What it reuses (and what it must never touch)

- Server logic is **imported from Recto**, not copied:
  `pdf_core.logic.document_store` (sha256-keyed doc cache, shared
  `media/doc_cache/`) and `pdf_core.logic.document_loader` (metadata +
  per-page rasters). The demo has no code of its own for document handling.
- The OCR engine (`ocr_tool/static/ocr_tool/engine/*.js`) and glyph packs
  (`glyphs/*`) are served **verbatim from ocr_tool/static** via
  `STATICFILES_DIRS` — these are synced from the external char_training repo
  and must **never** be edited or copied here.
- Base64 detection/decoding logic in `viewer/static/viewer/attachments.js` is
  ported from `base64_tool/static/base64_tool/base64-tool.js`.

The demo is deliberately **not** a Recto plugin: `demo/` has no top-level
`apps.py`, so Recto's plugin auto-discovery never installs it, and nothing in
baseline Recto references it.

## Deploying on a small VPS (the €5 plan)

Almost all visitors just click a sample card — so samples are pre-rendered to
static files and served by nginx; Python (gunicorn, 2 workers) only handles
the landing page and the occasional upload.

```bash
python demo/manage.py prerender_samples      # → demo/prerendered/<name>/{meta.json,1.png,…}
python demo/manage.py collectstatic --noinput # → demo/staticfiles/ (engine, glyphs, viewer JS)
```

Then install `demo/deploy/nginx-demo.conf` (nginx site — serves
`/prerendered/` and `/static/` from disk with far-future caching, proxies the
rest) and `demo/deploy/recto-demo.service` (systemd unit for gunicorn on
port 8001). Re-run `prerender_samples` whenever a sample PDF changes — it
skips unchanged files by hash. The frontend versions page-image URLs with
`?v=<sha>`, so replaced samples can never serve stale cached pages.

In dev nothing changes: the same `/prerendered/` URLs are served by a small
Django view, and a sample that hasn't been pre-rendered falls back to the
live `/open-sample` endpoint automatically.

## Sample PDFs

Drop `*.pdf` files into `demo/samples/` — each becomes a landing-page card.
The bundled startup PDF (`assets/pdfs/`) is listed automatically.

## Frontend layout

- `demo.js` — minimal single-page viewer (lazy `/page-image/<hash>/<n>`
  rasters, page nav, zoom, upload/drop/samples) + `DemoHooks`, a tiny event
  bus using Recto's event names (`document:loaded`, `page:rendered`).
- `ocr-adapter.js` — runs the blind reader page by page and emits
  `ocr:started` / `ocr:progress` / `ocr:page-done` / `ocr:done`; owns the
  progress pill and the page shimmer / line-highlight effects.
- `attachments.js` — re-scans the read prefix of the document after every
  page, renders attachment cards (type sniffed from magic bytes), holds back
  a run that reaches the reading frontier as a disabled partial card. There
  is no scan button; a small "Rescan document" link in the panel footer is
  the only manual fallback.
