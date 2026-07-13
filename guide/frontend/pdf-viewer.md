# PDF Viewer — `pdf-viewer.js`

[pdf-viewer.js](https://github.com/JaguarM/Recto/blob/main/pdf_core/static/pdf_core/pdf-viewer.js) handles file uploads and page rendering. It does **not** use PDF.js — pages are rendered from server-extracted base64 PNG images.

It injects **no overlays of any kind**. Once the pages are on screen it emits `document:loaded`
and stops; plugins put their own content on the page from there. A box-creating plugin's boxes
arrive this way, not from the viewer.

## Functions

### `handleFileUpload()`

Triggered when a file is selected or dropped. Sends the file to `POST /open-document`, then:

1. Parses the response into `state.pageImages`, `state.numPages`, `state.pageWidth`, `state.pageHeight`
2. Navigates to page 1
3. Renders thumbnails
4. Auto-detects font size and sets `suggested_scale`
5. Emits `document:loaded` with `{ file, isDefault, fontFamily, sizePt }` — the detected
   typography is passed along so box-creating plugins inherit the document's defaults

That is the whole sequence. The viewer creates no boxes and calculates no widths of its own;
anything that appears on top of the page was put there by a plugin subscribing to
`document:loaded`.

### `goToPage(pageNum)`

Switches the viewer to display a specific page:

1. Emits `viewer:clear` (plugins tear down per-page state — e.g. `webgl_mask` disposes GL contexts)
2. Creates a new `page-container` div with CSS custom properties for dimensions
3. Inserts an `<img>` element with the base64 page image and appends the container to the viewer
4. Emits `page:rendered` `{ pageContainer, pageNum }` — plugins draw their overlays (the `webgl_mask` mask canvas, the `text_tool` SVG text layer). **The core itself creates no overlay DOM.**
5. Emits `pages:refresh` so per-page overlays re-sync

### Text overlays

The viewer no longer injects DOM `redaction-overlay` divs with resizer handles. All boxes — embedded text, HarfBuzz recreations, and manually added boxes — are rendered as SVG `<text>`/`<g>` elements in a per-page `svg.text-layer`, owned by `text_tool` ([SVG Text Layer](embedded-text-viewer.md)). `text_tool/svg-renderer.js` builds that layer in response to the `page:rendered` event; drag, resize, selection, and inline editing are handled SVG-natively in `text_tool/drag-resize.js`, `inline-edit.js`, and `micro-typo.js`.

---

## Unified Options Bar

The viewer features a centralized text formatting toolbar (`#unified-options-bar-container`), shared by every plugin that puts text on the page.

Settings modified in this bar (Font, Size, Scale, etc.) are applied to the currently focused element, whatever kind of box it belongs to.

## Add Box to Line Tool

`text_tool` contributes a manual box tool, accessible via the `add_box` icon in the top toolbar.

**How it works:**
1. Click the tool to activate `state.activeTool = 'add-box'`.
2. Click anywhere on the PDF page.
3. `window._utbFindNearestLine()` (from `embedded_text_viewer`) searches for a text line within 2x height proximity.
4. If a line is found, the new box inherits that line's `y`, `height`, and `lineId`.
5. If no line is found, a default box is created at the click location.

> **Note:** the box it creates still carries `type: 'redaction'` — a leftover of the removed
> redaction plugin. The type name is load-bearing in `text_tool`'s styling and snapping code,
> so it is retained; see [Unified Text Box](../architecture/unified-text-box.md).
