# PDF Viewer — `pdf-viewer.js`

[pdf-viewer.js](https://github.com/JaguarM/EpsteinTool/blob/main/pdf_core/static/pdf_core/pdf-viewer.js) handles file uploads and page rendering. It does **not** use PDF.js — pages are rendered from server-extracted base64 PNG images.

It injects **no overlays of any kind**. Once the pages are on screen it emits `document:loaded`
and stops; plugins put their own content on the page from there. `redaction_lab`'s boxes arrive
this way, not from the viewer.

## Functions

### `handleFileUpload()`

Triggered when a file is selected or dropped. Sends the file to `POST /open-document`, then:

1. Parses the response into `state.pageImages`, `state.numPages`, `state.pageWidth`, `state.pageHeight`
2. Navigates to page 1
3. Renders thumbnails
4. Auto-detects font size and sets `suggested_scale`
5. Emits `document:loaded` with `{ file, isDefault, fontFamily, sizePt }` — the detected
   typography is passed along so box-creating plugins inherit the document's defaults
5. Initializes each redaction with per-redaction `settings` from the DOM controls
6. Calculates widths for all candidates via `calculateAllWidths()`
7. Injects redaction overlays and selects the first one

### `goToPage(pageNum)`

Switches the viewer to display a specific page:

1. Emits `viewer:clear` (plugins tear down per-page state — e.g. `webgl_mask` disposes GL contexts)
2. Creates a new `page-container` div with CSS custom properties for dimensions
3. Inserts an `<img>` element with the base64 page image and appends the container to the viewer
4. Emits `page:rendered` `{ pageContainer, pageNum }` — plugins draw their overlays (the `webgl_mask` mask canvas, the `text_tool` SVG text layer). **The core itself creates no overlay DOM.**
5. Emits `pages:refresh` so per-page overlays re-sync

### Redaction & text overlays

The viewer no longer injects DOM `redaction-overlay` divs with resizer handles. Redactions, embedded text, and HarfBuzz recreations are all rendered as SVG `<text>`/`<g>` elements in a per-page `svg.text-layer`, owned by `text_tool` ([SVG Text Layer](embedded-text-viewer.md)). `text_tool/svg-renderer.js` builds that layer in response to the `page:rendered` event; drag, resize, selection, and inline editing are handled SVG-natively in `text_tool/drag-resize.js`, `inline-edit.js`, and `micro-typo.js`.

---

## Unified Options Bar

The viewer features a centralized text formatting toolbar (`#unified-options-bar-container`). This bar is shared between the **Redaction Matcher** and the **Embedded Text Viewer**. 

Settings modified in this bar (Font, Size, Scale, etc.) are applied to the currently focused element, whether it is a redaction label or an ETV text span.

## Add Box to Line Tool

The viewer includes a manual redaction tool accessible via the `add_box` icon in the top toolbar.

**How it works:**
1. Click the tool to activate `state.activeTool = 'add-box'`.
2. Click anywhere on the PDF page.
3. The viewer calls `findNearestETVLine()` to search for a text line within 2x height proximity.
4. If a line is found, the new redaction inherits that line's `y`, `height`, and `lineId`.
5. If no line is found, a default redaction is created at the click location.
