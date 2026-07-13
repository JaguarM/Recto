---
home: true
heroImage: null
actions:
  - text: Get Started
    link: /architecture/architecture-overview.html
    type: primary
  - text: API Reference
    link: /api-reference/api-reference.html
    type: secondary
features:
  - title: Core + Plugins
    details: The core opens and renders a document, then gets out of the way. Every feature is a drop-in Django app the registry discovers on its own.
  - title: Real Typography
    details: HarfBuzz text shaping measures and places text with true font metrics, so what you add matches what was already there.
  - title: WebGL Visualization
    details: GPU-accelerated masks provide real-time interactive overlays over the rendered page.
footer: MIT Licensed | Copyright © 2026
---

# Recto Documentation

Recto is an extensible PDF editor. This guide covers its architecture, its plugin API, and
how to deploy it.

## Core concepts

Recto is built on a **core + plugin** architecture backed by **two registries**, one per side
of the stack, so the core never references a plugin by name.

- **Core (`pdf_core`)** — opens the document, rasterizes its pages, reads the embedded text
  and typography, and hosts the viewer. That is *all* it does: the core runs no analysis of
  its own. It provides the `PDFTool` base class + `@register_tool` decorator (backend wiring)
  and the `PDFHooks` event bus (frontend lifecycle wiring).
- **Plugins** — every actual feature. Text editing (`text_tool`), embedded-text inspection
  (`embedded_text_viewer`), GPU masking (`webgl_mask`), and backend extraction
  (`extracted_text`) are each an independent
  Django app. Each defines a `tool.py` subclassing `PDFTool`; the registry auto-discovers
  its styles, templates, scripts, and URL routes. Plugin JavaScript subscribes to lifecycle
  events with `PDFHooks.on(...)` rather than being called by name.
- **Adding a tool** — create the app folder with a `tool.py` and an `apps.py` whose `ready()`
  imports it. Django discovers the rest; no changes to `index.html`, `urls.py`, or
  `settings.py`.
- **Removing a tool** — delete the folder. The app, its routes, templates, static files, and
  event subscriptions all disappear together, leaving nothing dangling in the core.

The document lifecycle makes the boundary concrete: the core's `/open-document` returns the
pages and nothing else, then emits `document:loaded`. A plugin that wants to analyse the
document listens for that event and calls its own endpoint. `webgl_mask` is the reference
example — it posts the file to `/webgl/masks` and drops the overlays it gets back onto the
page. Delete it, and the core is unchanged: it never knew the plugin existed.

## Navigation

- **[Architecture Overview](./architecture/architecture-overview.md)** — the high-level system design.
- **[Tool Expansion Guide](./tool-expansion-guide.md)** — how to write a plugin against the `PDFTool` registry.
- **[Frontend Implementation](./frontend/javascript-module-reference.md)** — the vanilla JS and WebGL rendering engine.
- **[API Reference](./api-reference/api-reference.md)** — every JSON endpoint.
- **[Setup & Deployment](./setup-and-deployment/setup-deployment.md)** — local development and production.
- **[Optional Plugins](./plugins/)** — plugins that ship separately from the baseline. Nothing above depends on anything in there.
