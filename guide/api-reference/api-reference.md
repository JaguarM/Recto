# API Reference

The Django backend exposes several HTTP endpoints organized into modular apps.

> **Note:** All POST endpoints use `@csrf_exempt` — no CSRF token is required. There is no authentication.

## Endpoints

### `pdf_core` (Base Viewer)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serves the single-page application |
| `POST` | `/open-document` | Open a PDF or image: store it by content hash, return metadata only. No analysis. |
| `GET` | `/open-default` | Opens the startup document — the PDF sitting in `assets/pdfs/` (swap it by replacing the file; alphabetically first wins if several) |
| `GET` | `/page-image/<hash>/<n>` | One page's raster, on demand (`?thumb=1` for a 180 px sidebar variant) |

Both open endpoints include a `sha256` field (hash of the document bytes) in the response — a stable document identity that plugins key per-document requests off (exposed to the frontend as `state.docHash`). Opening **stores** the document server-side (`media/doc_cache/`, capped LRU), which is what makes every per-page endpoint possible: after the single upload, nothing ever re-sends the file.

### `text_tool` (Typography Plugin)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/widths` | Calculate pixel widths for candidate text strings |
| `GET` | `/fonts-list` | List available font files |

### `webgl_mask` (GPU Visualization Plugin)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/webgl/mask/<hash>/<n>` | Mask for one page of the stored document (204 = no redactions) — what the viewer uses |
| `POST` | `/webgl/masks` | Whole-document mask pass on an uploaded PDF (legacy fallback) |
| `GET` | `/webgl/masks?default=true` | Whole-document mask pass for the default PDF (legacy fallback) |

### `embedded_text_viewer` (Embedded Text Viewer Plugin)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/embedded-text-viewer/api/extract-spans?hash=<sha256>` | Spans for a page range of the stored document (`start`, `count`, `lean=1`) — what the viewer uses |
| `POST` | `/embedded-text-viewer/api/extract-spans` | Extract all text spans from an uploaded PDF (whole-document fallback) |
| `GET` | `/embedded-text-viewer/api/extract-spans` | Extract spans from the bundled default PDF (whole-document fallback) |

> **Note:** This endpoint is **optional** — if the `embedded_text_viewer` plugin folder is deleted, the endpoint is removed and the text overlay feature is disabled.

### `extracted_text` (Logic-only)

No HTTP endpoints. A pure-Python module (`extracted_text/logic/extract.py`) imported by `embedded_text_viewer.views`.

---

> **Optional plugins document their own endpoints.** This reference covers the core and the
> baseline plugins only. A plugin that adds routes owns their documentation, in its own folder
> under [`guide/plugins/`](../plugins/) — so removing the plugin removes its API docs with it,
> and this page never goes stale.

---

## `POST /open-document`

Open a PDF or image: store it once (keyed by its SHA-256), describe it.

The response is **metadata only** — page count, geometry, typography, and the document's
hash. Page rasters are fetched lazily, one page at a time, from
[`GET /page-image/<hash>/<n>`](#get-page-imagehashn); embedded text belongs to the
plugins that read it. This is what lets a two-thousand-page document open in seconds:
the open response stays a few hundred bytes no matter the document size.

This endpoint runs **no analysis**. Plugins that analyse the document (such as
`webgl_mask`) subscribe to the frontend `document:loaded` hook and call their own
endpoints with `state.docHash`.

### Request

- **Content-Type:** `multipart/form-data`
- **Body:** Form field `file` containing the uploaded file

Supported formats:
- PDF (`application/pdf`)
- Images: PNG, JPEG, TIFF, BMP, WebP

### Response — `200 OK`

```json
{
  "sha256": "9f2c…64 hex chars…e1",
  "pdf_fonts": ["TimesNewRomanPSMT", "TimesNewRomanPS-BoldMT"],
  "suggested_scale": 133,
  "suggested_size": 12.0,
  "page_image_type": "image/png",
  "page_width": 816,
  "page_height": 1056,
  "num_pages": 3
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sha256` | string | Content hash of the stored document — the identity every per-page endpoint takes |
| `pdf_fonts` | array | Base-font names declared in the PDF, sorted by number of pages they appear on (most common first). `[]` for images. |
| `suggested_scale` | int | Recommended "Scale %" for the width calculator. `133` for standard 816 px / 612 pt letter pages. See [Scale & Size Detection](../architecture/scale-and-size-detection.md). |
| `suggested_size` | float | Dominant body-text font size in points, sampled from the leading pages' text spans. `12.0` when unknown. |
| `page_image_type` | string | MIME type of the page rasters — `"image/png"` for PDFs, the source MIME for image uploads |
| `page_width` / `page_height` | int | Pixel dimensions of the page rasters (816 × 1056 for standard PDFs; actual image dimensions for raw image uploads) |
| `num_pages` | int | Total number of pages |

### Errors

| Status | Reason |
|--------|--------|
| `400` | No file uploaded or no file selected |
| `500` | Processing error (detail in response body) |

---

## `GET /page-image/<hash>/<n>`

One page's raster from the stored document. For PDFs this is the page's embedded
image (cropped to the 8.5×11 ratio — the exact pixels every coordinate consumer
shares); pages with no usable embedded raster are rendered at 96 DPI instead, which
lands in the same pixel space. Raw image documents return the stored file.

`?thumb=1` returns a 180 px wide PNG for the thumbnail sidebar.

Responses carry `Cache-Control: immutable` — the URL embeds the content hash, so the
browser caches pages forever and revisiting a page never re-asks the server.

| Status | Reason |
|--------|--------|
| `200` | Image bytes (`image/png`, or the stored image's MIME) |
| `404` | Unknown/malformed hash, or page out of range |

---

## `POST /widths`

Calculate pixel widths for a list of text strings using HarfBuzz text shaping.

### Request

- **Content-Type:** `application/json`

```json
{
  "strings": ["Hamburgefonstiv", "Quick Brown Fox"],
  "font": "times.ttf",
  "size": 12,
  "scale": 133,
  "kerning": true,
  "force_uppercase": false
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strings` | array | `[]` | Text strings to measure |
| `font` | string | `"times.ttf"` | Font filename from `assets/fonts/` |
| `size` | number | `12` | Font size in points |
| `scale` | number | `135` | Scale percentage (divided by 100 internally to get `scale_factor`) |
| `kerning` | bool | `true` | Enable OpenType `kern` feature |
| `force_uppercase` | bool | `false` | Measure uppercase version of each string |

The width formula applied by the backend is:

```
pixel_width = (advance / upem) × size × (scale / 100)
```

With `scale = 133` and `size` set to the document's body-text size, this matches the pixel-space width of that text as it appears in the embedded page images.

### Response — `200 OK`

```json
{
  "results": [
    { "text": "Hamburgefonstiv", "width": 89.472 },
    { "text": "Quick Brown Fox", "width": 107.136 }
  ]
}
```

---

## `GET /fonts-list`

Returns a JSON array of available `.ttf` font filenames from `assets/fonts/`.

### Response — `200 OK`

```json
["times.ttf", "arial.ttf", "courier_new.ttf", "calibri.ttf"]
```

---

## `GET /webgl/mask/<hash>/<n>`

Redaction mask for one page of the stored document, detected on demand. This is how
the viewer loads masks: a page's mask is requested only when that page's overlay
initializes, and nothing is ever re-uploaded.

| Status | Reason |
|--------|--------|
| `200` | Grayscale PNG mask (`255` = redacted interior, `0` = clear, mid-gray = border) |
| `204` | Page analysed, no redactions found (a normal answer, cacheable) |
| `404` | Unknown/malformed hash |

Responses carry `Cache-Control: immutable` — a mask is deterministic per content hash + page.

---

## `POST /webgl/masks` (legacy fallback)

Whole-document mask pass on an uploaded PDF; `GET /webgl/masks?default=true` does the
same for the bundled default PDF. Returns `{ "mask_images": [base64-PNG-or-null, …] }`,
one entry per page. The viewer no longer calls these — they remain for external
callers that want a single-shot pass.

---

## `GET /embedded-text-viewer/api/extract-spans?hash=<sha256>`

Extract text spans from the **stored** document, one page range at a time. This is how
`etv-fetch.js` populates the SVG text overlay: a background loop fetches `lean=1`
chunks for the whole document, and full spans are fetched per page (`count=1`) when
that page is rendered.

| Query param | Default | Description |
|-------------|---------|-------------|
| `hash` | — | The document's `sha256` from `/open-document` |
| `start` | `1` | First page (1-based) |
| `count` | `200` | Pages in this chunk (capped at 200) |
| `lean` | off | `1` strips each span to `page, text, x, y, w, h, sizePt, font` — about a tenth of the full payload; full spans additionally carry `chars`, `lineId`, `flags`, `fontSize`, … |

Response: `{ "spans": [...], "num_pages": N }` (span schema below). `404` for an
unknown hash.

---

## `POST /embedded-text-viewer/api/extract-spans` (whole-document fallback)

Extract all text spans from an uploaded PDF in one shot.

### Request

- **Content-Type:** `multipart/form-data`
- **Body:** Form field `file` containing the uploaded PDF

### Response — `200 OK`

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

| Field | Type | Description |
|-------|------|-------------|
| `page` | int | 1-based page number |
| `text` | string | Full text content of the span |
| `x`, `y` | float | Top-left position in document pixel space (816×1056 base) |
| `w`, `h` | float | Width and height of the span bounding box |
| `fontSize` | float | Font size in CSS pixels |
| `sizePt` | float | Font size in PDF points |
| `font` | string | Base font name from the PDF (e.g. `"TimesNewRomanPSMT"`) |
| `flags` | int | PyMuPDF font flags bitmask |
| `lineId` | string | Groups spans on the same horizontal text line (e.g. `"1_3"`) |
| `chars` | array | Per-character data: `c` (character), `x` (x offset within span), `w` (advance width) |

### Errors

| Status | Reason |
|--------|--------|
| `400` | No file uploaded or no file selected |
| `500` | Processing error (detail in response body) |

---

## `GET /embedded-text-viewer/api/extract-spans`

Utility endpoint to extract spans from the bundled default demonstration PDF.

### Response — `200 OK`

Returns the same schema as `POST /embedded-text-viewer/api/extract-spans`.

