# State Management — `state.js`

[state.js](https://github.com/JaguarM/EpsteinTool/blob/main/pdf_core/static/pdf_core/state.js) defines two global objects used by all other frontend modules.

Both hold **core state only**. Plugin state lives in the plugin — the core object graph
contains nothing that would dangle if a plugin folder were deleted.

## `state` — Application State

```javascript
const state = {
  // PDF Viewer
  pageImages: [],         // data URLs (base64), index 0 = page 1
  numPages: 0,
  pageWidth: 816,         // pixel width of page images
  pageHeight: 1056,       // pixel height of page images
  currentPage: 1,
  currentZoom: 1.0,
  minZoom: 0.5,
  maxZoom: 8.0,
  renderQueue: [],

  // Document
  hasPdf: false,
  currentFile: null,      // the File the user opened — plugins may re-post it

  activeTool: null,       // 'add-box' or null
};
```

`currentFile` is the one field plugins reach for: a plugin that needs to run its own
server-side pass over the open document (as `redaction_lab` does) re-posts this `File` to its
own endpoint from the `document:loaded` hook. The core does not cache the document
server-side, so both passes are stateless.

### `utbState` — Unified Text Box State

All text on the page — embedded PDF text, redaction labels, HarfBuzz recreations — is managed
through the global `utbState` object defined in `text_tool/unified-text-box.js`:

```javascript
const utbState = {
  boxes: [],              // UnifiedTextBox[] — single array for all text
  selectedId: null,       // id of currently selected box
  microTypoId: null,      // id of box in micro-typography nudge mode
  microTypoCharIdx: null, // index of the character being nudged
  editingId: null,        // id of box in inline-text-edit mode
};
```

A box carries a `type`, and plugins may contribute their own. `redaction_lab` adds boxes with
`type: 'redaction'` on `document:loaded`; `text_tool` renders and edits them like any other
box. This is how a plugin puts content on the page without the core knowing it exists.

See [SVG Text Layer](embedded-text-viewer.md) for the full `UnifiedTextBox` data model.

## `els` — DOM Element Cache

Core DOM elements are cached at load time to avoid repeated `getElementById` calls:

| Group | Elements |
|-------|----------|
| **Viewer** | `dragOverlay`, `viewerContainer`, `viewer`, `titleElem`, `pageCountElem`, `pageInputElem`, `zoomInputElem`, `zoomInBtn`, `zoomOutBtn`, `sidebar`, `toggleSidebarBtn`, `thumbnailView`, `prevPageBtn`, `nextPageBtn` |
| **Tools** | `toolsSidebar`, `toggleToolsBtn`, `toolAddBoxBtn`, `toolTextBtn` |
| **Data** | `pdfFile` |

> **Plugin-owned controls are not in `els`.** The core cache holds no plugin elements — not the
> webgl mask toggle (`#toggle-webgl`), the reveal-strength slider (`#edge-subtract`), the ETV
> add-text button, nor `redaction_lab`'s Match controls (`#tolerance`, `#kerning`,
> `#force-uppercase`). Each plugin looks up its own DOM with `document.getElementById(...)`,
> typically from a `PDFHooks.on('ui:ready', …)` handler — see the
> [PDFHooks pattern](../tool-expansion-guide.md#frontend-lifecycle--the-pdfhooks-bus).
