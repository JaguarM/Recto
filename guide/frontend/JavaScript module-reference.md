# Frontend — JavaScript Module Reference

The frontend is a single-page application built with vanilla JavaScript (no build step). Scripts are loaded in order via `<script>` tags in `index.html`.

## Loading Order

The scripts must load in this exact order because later modules depend on globals defined by earlier ones:

| Order | File | Defines | Depends On |
|-------|------|---------|------------|
| 1 | `pdf_core/state.js` | `state`, `els` | DOM elements |
| 2 | `redaction_matching/api.js` | `addName`, `calculateAllWidths`, `renderCandidates`, `selectRedaction`, `createNewRedaction` | `state`, `els` |
| 3 | `webgl_mask/webgl-mask.js` | `setupWebGLOverlay`, `clearWebGLContexts`, `updateWebGLUniforms`, `fetchMasksAsync` | `state`, `els` |
| 4 | `pdf_core/pdf-viewer.js` | `handleFileUpload`, `goToPage`, `loadDocument` | `state`, `els`, `api.js`, `webgl-mask.js` |
| 5 | `pdf_core/ui-events.js` | `updateCSSZoom`, `processZoomFromText`, `renderThumbnails` | `state`, `els` |
| 6 | `pdf_core/app.js` | IIFE — wires all event listeners | All above |
| 7 | `text_tool/unified-text-box.js` | `UnifiedTextBox`, `utbState`, `spanToUnified`, `normUtbFont` | — |
| 8 | `text_tool/svg-renderer.js` | `renderBox`, `renderTextLayer`, `renderAllTextLayers`, `selectBoxInSVG`, `computeXPositions` | `utbState` |
| 9 | `text_tool/drag-resize.js` | IIFE — SVG-native drag/resize event delegation | `utbState`, `renderBox` |
| 10 | `text_tool/toolbar.js` | `syncToolbarToBox`, `syncToolbarToSelection`, `persistFromToolbar` | `utbState`, `renderBox` |
| 11 | `text_tool/micro-typo.js` | `enterMicroTypo`, `exitMicroTypo` | `utbState`, `computeXPositions`, `renderBox` |
| 12 | `text_tool/inline-edit.js` | `enterInlineEdit`, `commitInlineEdit`, `cancelInlineEdit` | `utbState`, `renderBox`, `exitMicroTypo` |
| 13 | `text_tool/text-tool.js` | `utbFetchSpans`, `utbConnectRedactionsToLines`, `addEmbeddedTextSpan`, `handleManualAddBox` | `utbState`, `renderBox`, all above |

## External Libraries

| Library | CDN | Purpose |
|---------|-----|---------|
| Fabric.js 5.3.1 | cloudflare | Legacy canvas — still loaded but not used for text rendering |
| Material Symbols | Google Fonts | Toolbar icons |
| Inter font | Google Fonts | UI typography |

## Module Documentation

- [State Management](state-management.md) — `state` object schema and `els` DOM cache
- [PDF Viewer](pdf-viewer.md) — File upload, page navigation, rendering
- [API & Candidate Logic](api-and-logic.md) — Width calculation, candidate matching, sort/pagination
- [UI Events](ui-events.md) — Zoom, resize, drag, thumbnails
- [SVG Text Layer](embedded-text-viewer.md) — `UnifiedTextBox` data model, SVG rendering, inline editing, micro-typography
- [Toolbar & Text Tool](text-tool.md) — Formatting toolbar controls, span fetching, lifecycle hooks
- [WebGL Mask](webgl-mask.md) — GPU-accelerated redaction mask rendering
