# UI Events — `ui-events.js`

[ui-events.js](https://github.com/JaguarM/Recto/blob/main/pdf_core/static/pdf_core/ui-events.js) handles zoom controls, box resizing/dragging, and thumbnail rendering.

## Zoom

### `updateZoomLevelText()`
Syncs the zoom input display with `state.currentZoom`.

### `updateCSSZoom()`
Applies the current zoom by setting the `--scale-factor` CSS custom property on the viewer, then emits the `zoom:changed` PDFHooks event (`{ zoom }`) so any plugin that needs a zoom-aware redraw can subscribe. The core no longer calls a named `onZoomChange` hook.

### `processZoomFromText(newZoom, mouseX?, mouseY?)`
Constrains the zoom to `[minZoom, maxZoom]`, updates `state.currentZoom`, and applies. When mouse coordinates are provided (Ctrl+Wheel), preserves the document position under the cursor by adjusting scroll offsets.

**Zoom is CSS-only** — no canvas re-rendering is needed because pages are `<img>` elements that scale via CSS transforms.

## Box Resizing & Dragging

> The old `initResize()` / `initDragRedaction()` overlay handlers have been **removed** from `ui-events.js`. Boxes are now SVG elements, and drag/resize is handled entirely by SVG-native event delegation in [`text_tool/drag-resize.js`](text-tool.md). See [SVG Text Layer](embedded-text-viewer.md).

## Thumbnails

### `renderThumbnails()`
Builds the sidebar thumbnail strip from `state.pageImages`. Each thumbnail is a 180px-wide `<img>` with a page number label. Clicking navigates to that page via `goToPage()`. The active page gets the `.active` class.
