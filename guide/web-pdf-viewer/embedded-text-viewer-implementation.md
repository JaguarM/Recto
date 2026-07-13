# Embedded Text Viewer Implementation

The `embedded_text_viewer` is a fully self-contained, removable Django plugin app that fetches all embedded PDF text spans from the backend and renders them as an SVG overlay directly on top of the main viewer's page canvas. It makes any text hidden underneath page graphics visible by drawing it in blue at its original coordinates.

## Features

- **Integrated Overlay:** Renders natively inside the main `pdf_core` viewer — no separate page or window required.
- **Toggle Button:** A toolbar icon (`toggle-embedded-text`) activates/deactivates the overlay without leaving the current view.
- **SVG-Based Rendering:** Text is rendered as SVG `<text>` elements via `text_tool/svg-renderer.js`, not DOM spans.
- **Fully Removable:** Deleting the `embedded_text_viewer` folder removes the button, the API endpoint, and all span-fetching JS in one step.

## Architecture

The plugin follows the standard Recto "toolbar button + overlay" pattern used by `webgl_mask` and `text_tool`:

```mermaid
sequenceDiagram
    participant User
    participant ToolbarBtn as Toggle Button
    participant JS as etv-fetch.js
    participant API as POST /embedded-text-viewer/api/extract-spans
    participant State as utbState
    participant Renderer as svg-renderer.js

    User->>ToolbarBtn: Click (pdf-file change / auto-fetch on load)
    JS->>API: POST uploaded PDF file
    Note over API: embedded_text_viewer/views.py<br/>imports extracted_text.logic.extract<br/>PyMuPDF extracts rawdict spans<br/>Returns normalized span data
    API-->>JS: JSON { spans: [...] }
    JS->>JS: Normalize font sizes (median-pt snap)
    JS->>State: Remove old type='embedded' boxes; add new UnifiedTextBox entries
    JS->>Renderer: renderAllTextLayers()
    JS->>JS: utbConnectRedactionsToLines()
    Note over Renderer: SVG <text> elements rendered<br/>in blue over each page image
```

## Span Fetching — `etv-fetch.js`

`etv-fetch.js` (in `static/embedded_text_viewer/`) owns all ETV-specific frontend logic:

- **`utbFetchSpans(file)`** — POSTs the PDF to `/embedded-text-viewer/api/extract-spans`, normalizes font sizes, populates `utbState` with `type='embedded'` `UnifiedTextBox` objects, and calls `renderAllTextLayers()`.
- **`utbConnectRedactionsToLines()`** — Links redaction boxes to their overlapping embedded text lines by snapping `lineId`, `y`, and `h`.
- **`window.addEmbeddedTextSpan(pageNum, x, y)`** — Creates a new `type='embedded'` box, snaps to the nearest text line, selects it, and opens the toolbar.
- **`window._utbFindNearestLine(pageNum, y)`** — Helper used by `text_tool/text-tool.js` when placing manual boxes (optional: gracefully absent if ETV plugin is not installed).
- **`document:loaded` subscription** — Subscribes to the core's `document:loaded` PDFHooks event and (re)fetches spans for the newly loaded document. The plugin no longer monkey-patches `window.loadDocument`; the core resets `utbState`/SVG layers itself at the top of `loadDocument`.
- **`pdf-file` change listener** — Clears stale overlays the moment a new file is selected, before analysis returns (the actual re-fetch happens on the subsequent `document:loaded`).

`etv-fetch.js` is declared in `embedded_text_viewer/tool.py` as a `scripts_after_app` entry and is loaded by the registry after all core scripts.

## Backend — `embedded_text_viewer/views.py`

The `extract_spans` view lives in `embedded_text_viewer/views.py`. It imports `extract_pdf` from `extracted_text.logic.extract` (a pure logic module with no active routes of its own) and returns the full span payload used by `etv-fetch.js`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/embedded-text-viewer/api/extract-spans` | Accepts a PDF file upload (`file`). Returns JSON with a `spans` array. |
| `GET` | `/embedded-text-viewer/api/extract-spans` | Returns spans for the bundled default PDF. |

### Response Format

```json
{
  "spans": [
    {
      "page": 1,
      "text": "IN THE CIRCUIT COURT",
      "x": 245.33,
      "y": 112.67,
      "w": 326.00,
      "h": 16.00,
      "fontSize": 16.00,
      "sizePt": 12.0,
      "font": "TimesNewRomanPSMT",
      "flags": 0,
      "lineId": "1_3",
      "chars": [{"c": "I", "x": 0.0, "w": 8.2}]
    }
  ]
}
```

## Files

```
embedded_text_viewer/
├── tool.py                          # EmbeddedTextViewerTool — scripts_after_app declares etv-fetch.js
├── views.py                         # extract_spans endpoint (imports extracted_text.logic.extract)
├── urls.py                          # api/extract-spans route
├── templates/embedded_text_viewer/
│   └── toolbar_button.html          # toggle-embedded-text button injected into toolbar
└── static/embedded_text_viewer/
    ├── etv-fetch.js                 # All ETV frontend logic: fetching, lifecycle, line-snapping
    └── styles.css                   # Overlay positioning & text styles
```
