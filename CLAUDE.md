# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Recto is an extensible PDF editor built on Django 6: open a PDF or scanned image, edit/add text with true font metrics (HarfBuzz shaping), mask regions, inspect embedded text. Vanilla JS + Fabric.js + WebGL frontend, no build step, no JS package manager.

## Commands

```bash
python -m pip install -r requirements.txt   # install deps
python manage.py runserver 5000             # run dev server → http://localhost:5000
python manage.py check                      # sanity check (used to verify plugin removal)
python manage.py test                       # run tests (per app: python manage.py test text_tool)
```

On Windows, `run_app.bat` does install + runserver + opens the browser. `setup.sh` is the Linux production installer (Gunicorn + Nginx + systemd) — not for local dev.

## Architecture: core + plugins, two registries

The dividing line is strict: **`pdf_core` opens the document, rasterizes pages, extracts embedded text/typography, and runs no analysis.** Every feature beyond that is a plugin — an independent Django app whose folder can be deleted with no dangling references. Full docs live in `guide/` (start with `guide/architecture/architecture-overview.md` and `guide/tool-expansion-guide.md`).

Decoupling happens on both ends of the stack:

- **Backend — `@register_tool` registry** (`pdf_core/registry.py`): each plugin's `tool.py` defines a `PDFTool` subclass (`pdf_core/base.py`) declaring its toolbar button, options/ribbon bars, sidebar, scripts, styles, and URL module. `recto/urls.py` and `pdf_core/templates/pdf_core/index.html` iterate the registry — **never edit `index.html`, `recto/urls.py`, or `settings.py` to add a plugin.** `settings.py` auto-appends to `INSTALLED_APPS` any top-level folder containing an `apps.py`; the plugin's `apps.py` `ready()` imports `tool.py` to trigger registration.
- **Frontend — `PDFHooks` event bus** (`pdf_core/static/pdf_core/hooks.js`, loaded before all other scripts): the core viewer emits lifecycle events (`ui:ready`, `viewer:clear`, `page:rendered`, `pages:refresh`, `document:loaded`, `zoom:changed`); plugins subscribe with `PDFHooks.on(...)`. The core never calls a plugin function by name. Handlers may be async and a throwing handler can't break the core.

Analysis is a second, plugin-owned pass: plugins listen for `document:loaded`, re-post `state.currentFile` to their own endpoint, and draw their own overlays.

### Baseline apps

| App | Role |
|---|---|
| `pdf_core` | Core: document loading, page rendering, viewer, registry, hook bus |
| `text_tool` | Edit/add text with HarfBuzz-measured widths (`/widths`, `/fonts-list`) |
| `embedded_text_viewer` | Inline overlay of the PDF's embedded text spans |
| `webgl_mask` | OpenCV black-region detection + GPU mask tinting |
| `extracted_text` | Logic-only (no PDFTool, no UI, no routes) — `extract_pdf()` imported by `embedded_text_viewer` |

Optional plugins are documented **only** in `guide/plugins/` — baseline code and baseline docs must never name an optional plugin (that's the contract; a mention elsewhere is a leak to fix). Optional plugins attach only through the `PDFHooks` bus and guarded globals (`typeof fn === 'function'` call sites in `text_tool`).

## Coordinate contract

`pdf_core/logic/geometry.py` is the single source of truth (JS mirror: `text_tool/static/text_tool/geometry.js`, `window.GEO`). Two spaces: **image pixels at 96 DPI** (canonical geometry — box x/y/w/h, SVG viewBox) and **PDF points at 72 DPI** (canonical typography — `sizePt`). Font size converts to px exactly once, at the SVG render boundary. Import the named constants; never re-derive `0.75`, `133`, `816`, etc.

## Frontend conventions

- Script load order: `hooks.js` → `state.js` → plugin `scripts_before_viewer` → `pdf-viewer.js` → `ui-events.js` → `app.js` → plugin `scripts_after_app`. Scripts in `scripts_before_viewer` can't call `app.js` globals (`openSubtoolbar`, `registerSubtoolbar`) at module scope — defer to a `PDFHooks.on('ui:ready', …)` handler.
- `state` and `els` (in `state.js`) hold **core-only** state and DOM refs. Plugin state lives in the plugin; plugins look up their own DOM with `document.getElementById(...)` using optional chaining (`?.`) so removal never throws.
- Toggle visibility only via the `.hidden` class (CSS transitions key on it), never `display:` directly.
- Subtoolbar plugins register their toggle with `window.registerSubtoolbar(btn)` and open/close via `window.openSubtoolbar(bar, btn)` — one options bar visible at a time. Right-panel plugins are fully self-owned: the plugin's `sidebar` template supplies its own container element, the plugin ships its own CSS and toggle wiring, and the core hosts no right panel — there is no core touchpoint.
- `PDFTool` class attributes use tuples for sequence defaults (mutable-default trap); subclasses may assign lists.
- `guide/ui-map.md` maps every visible control (label/tooltip → owning plugin → template → handler script). Update it in the same change whenever a control is added, moved, renamed, or removed.
