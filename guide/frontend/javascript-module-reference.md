# Frontend — JavaScript Module Reference

The frontend is a single-page application built with vanilla JavaScript (no build step). Scripts are loaded in order via `<script>` tags in `index.html`.

## Loading Order

Scripts load in this order. Cross-module integration happens through the **`PDFHooks`** event bus (module 1) rather than the core calling plugin functions by name, so plugins are wired by *subscribing* to lifecycle events at runtime — the load order below matters only for the few direct global dependencies noted in the last column.

| Order | File | Defines | Subscribes / Emits | Depends On |
|-------|------|---------|--------------------|------------|
| 1 | `pdf_core/hooks.js` | `PDFHooks` (`on`/`off`/`emit`) | — | — (loaded first) |
| 2 | `pdf_core/state.js` | `state`, `els` | — | DOM elements |
| 4 | `webgl_mask/webgl-mask.js` | `setupWebGLOverlay`, `clearWebGLContexts`, `updateWebGLUniforms`, `fetchMasksAsync`, `refreshWebGLCanvases` | **on:** `ui:ready`, `viewer:clear`, `page:rendered`, `pages:refresh`, `document:loaded` | `state` |
| 5 | `pdf_core/pdf-viewer.js` | `handleFileUpload`, `goToPage`, `loadDocument` | **emit:** `viewer:clear`, `page:rendered`, `pages:refresh`, `document:loaded` | `state`, `els` |
| 6 | `pdf_core/ui-events.js` | `updateCSSZoom`, `processZoomFromText`, `renderThumbnails` | **emit:** `zoom:changed` | `state`, `els` |
| 7 | `pdf_core/app.js` | IIFE — wires core listeners; `openSubtoolbar`, `registerSubtoolbar`, `openRightPanel` | **emit:** `ui:ready` | All above |
| 8 | `text_tool/unified-text-box.js` | `UnifiedTextBox`, `utbState`, `spanToUnified`, `normUtbFont` | — | — |
| 9 | `text_tool/svg-renderer.js` | `renderBox`, `renderTextLayer`, `renderAllTextLayers`, `selectBoxInSVG`, `computeXPositions` | **on:** `page:rendered` | `utbState` |
| 10 | `text_tool/drag-resize.js` | IIFE — SVG-native drag/resize event delegation | — | `utbState`, `renderBox` |
| 11 | `text_tool/toolbar.js` | `syncToolbarToBox`, `syncToolbarToSelection`, `persistFromToolbar` | — | `utbState`, `renderBox` |
| 12 | `text_tool/micro-typo.js` | `enterMicroTypo`, `exitMicroTypo` | — | `utbState`, `computeXPositions`, `renderBox` |
| 13 | `text_tool/inline-edit.js` | `enterInlineEdit`, `commitInlineEdit`, `cancelInlineEdit` | — | `utbState`, `renderBox`, `exitMicroTypo` |
| 14 | `text_tool/text-tool.js` | `handleManualAddBox` | — | `utbState`, `renderBox`, all above |
| 15 | `embedded_text_viewer/etv-fetch.js` | `utbFetchSpans`, `utbConnectRedactionsToLines`, `addEmbeddedTextSpan`, `_utbFindNearestLine` | **on:** `document:loaded` | `utbState`, `renderBox`, `text-tool.js` (runtime) |

> **Slot 3 is the optional-plugin slot.** It is a `scripts_before_viewer` position — after `state.js`, before `pdf-viewer.js` — reserved for plugins that must define globals the baseline modules call behind `typeof` guards. No baseline plugin fills it. See [Optional Plugins](../plugins/).

> **Note:** Because `PDFHooks` is defined first and subscriptions are order-independent, a plugin can call `PDFHooks.on(...)` at module scope regardless of where it loads. `etv-fetch.js` subscribes to `document:loaded` instead of monkey-patching `window.loadDocument` (the previous, fragile approach). Its cross-module calls into `text_tool` still happen inside event handlers, so the load order remains safe.

## External Libraries

| Library | CDN | Purpose |
|---------|-----|---------|
| Fabric.js 5.3.1 | cloudflare | Legacy canvas — still loaded but not used for text rendering |
| Material Symbols | Google Fonts | Toolbar icons |
| Inter font | Google Fonts | UI typography |

## Module Documentation

- [State Management](state-management.md) — `state` object schema and `els` DOM cache
- [PDF Viewer](pdf-viewer.md) — File upload, page navigation, rendering
- [Optional Plugins](../plugins/) — plugins outside the baseline, and the guarded-global seams they attach through
- [UI Events](ui-events.md) — Zoom, resize, drag, thumbnails
- [SVG Text Layer](embedded-text-viewer.md) — `UnifiedTextBox` data model, SVG rendering, inline editing, micro-typography
- [Toolbar & Text Tool](text-tool.md) — Formatting toolbar controls, span fetching, lifecycle hooks
- [WebGL Mask](webgl-mask.md) — GPU-accelerated mask rendering
