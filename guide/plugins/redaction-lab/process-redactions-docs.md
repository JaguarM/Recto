# detect.py

[detect.py](https://github.com/JaguarM/EpsteinTool/blob/main/pdf_core/logic/detect.py) is the main orchestrator for PDF and image analysis. It opens the uploaded file, extracts embedded page images, runs redaction box detection, refines box boundaries using surrounding text, and collects font metadata — returning the core structural data the frontend needs in a single JSON-serialisable dict.

---

## Functions

### `process_pdf(pdf_bytes)`

The primary entry point for PDF files. Accepts raw bytes from the uploaded file and processes every page.

**Returns** a dict with:

| Key | Type | Description |
|-----|------|-------------|
| `redactions` | list | Detected redaction boxes, sorted page → y → x |
| `spans` | list | Text spans extracted from the PDF text layer |
| `pdf_fonts` | list[str] | Base-font names declared in the PDF, sorted by page-frequency (most common first) |
| `suggested_scale` | int | Recommended "Scale %" for the width calculator (see [Scale & Size Detection](scale-and-size-detection.md)) |
| `suggested_size` | float | Detected dominant body-text size in points (see [Scale & Size Detection](scale-and-size-detection.md)) |
| `page_images` | list | Base64-encoded PNG string for each page (one per page, `null` if none found) |
| `page_image_type` | str | MIME type — always `"image/png"` |
| `page_width` | int | Fixed pixel width — `816` |
| `page_height` | int | Fixed pixel height — `1056` |
| `num_pages` | int | Total number of pages in the document |

**Redaction object shape:**

```json
{
  "page": 1,
  "x": 203.0,
  "y": 438.0,
  "width": 121.53,
  "height": 16.0,
  "area": 1944.48
}
```

Coordinates are in the pixel space of the embedded 816 × 1056 px page image.

**Span object shape:**

```json
{
  "page": 1,
  "text": "Confidential",
  "bbox": [100.0, 438.0, 200.0, 454.0],
  "font": {
    "size": 12.0,
    "flags": 0,
    "matched_font": "TimesNewRomanPSMT"
  }
}
```

---

### `process_image(image_bytes, mime_type)`

Handles raw image uploads (PNG, JPEG, TIFF, …). Runs the same box detection pipeline but skips text-span extraction and font detection.

Returns the same structure as `process_pdf()` with:
- `spans` always `[]`
- `suggested_scale` always `geo.DEFAULT_SCALE` (`133`; no page geometry is available, so it uses the same 96-dpi default as PDFs — earlier versions hardcoded `178` here)
- `page_width` / `page_height` reflect the actual uploaded image dimensions

---



---

## Processing Pipeline (PDF path)

```
pdf_bytes
  │
  ▼
fitz.open()  ──► per-page loop
                  │
                  ├─ page.get_fonts()         → pdf_font_pages (declared font registry)
                  │
                  ├─ page.get_text("dict")    → text_spans (size, flags, font name)
                  │
                  └─ doc.get_page_images()    → per image on the page
                        │
                        ├─ doc.extract_image()               → raw PNG/TIFF bytes
                        ├─ find_redaction_boxes_in_image()   → pixel-space boxes
                        ├─ page.get_image_rects()            → placement rect in PDF pts
                        │     └─ captures page_scale_ratio = img_px / page_pts
                        └─ _get_pipeline().run(box, {"etv": evidence})
                              → RefinerPipeline merges edge proposals from the
                                registered refiners (currently EtvRefiner, which
                                wraps estimate_widths_for_boxes and applies its
                                own width-change guard — see below)

  ▼
Post-loop calculations
  ├─ redactions.sort(page → y → x)
  ├─ suggested_scale  = round(100 × page_scale_ratio)   [133 for standard 816 px / 612 pt pages]
  └─ suggested_size   = mode of body-text span sizes, rounded to 0.5 pt
                        (spans ≥ 20 chars preferred; falls back to all spans)
```

---

## Coordinate System

All redaction coordinates are in the **embedded image's pixel space** (typically 816 × 1056 px). This matches what the frontend renders, so overlay divs can be positioned directly using these values.

PDF text spans from `page.get_text("dict")` are in **PDF points** (72 dpi). The conversion factor `page_scale_ratio` (captured during image processing) bridges the two spaces:

```
image_pixels = pdf_points × page_scale_ratio
             = pdf_points × (816 / 612)          ← standard letter pages
             = pdf_points × 1.3333
```

This same ratio is what `suggested_scale / 100` represents — see [Scale & Size Detection](scale-and-size-detection.md) for the derivation.

---

## Edge Refinement (refiner pipeline)

`detect.py` does **not** refine edges itself. For each detected box it
runs the refiner pipeline (`_get_pipeline().run(box, {"etv": evidence})`), which
the core builds from the `RefinerRegistry` and so stays decoupled from any
concrete refiner. The only edge guard — accept the proposed edge only when the
width change is within tolerance — now lives **inside the refiner**, not here:

```python
# redaction_refiner/etv_refiner.py
allowed = max(self._max_width_change * box.width, float(geo.GRID_PX))  # 25% of width, floored at one grid cell
if abs((temp_x2 - temp_x1) - box.width) > allowed:
    return BoxProposal()        # abstain -> box keeps its raw BoxDetector edge
```

The grid-cell floor ensures a bounded ¼-inch grid snap on a small box is not
silently rejected. See [SurroundingWordWidth](surrounding-word-width.md) for the
edge reconstruction itself and the refiner architecture in
[architecture-overview](../architecture/architecture-overview.md).

---

## Dependencies

| Module | Used for |
|--------|----------|
| `BoxDetector.find_redaction_boxes_in_image()` | Raw black-box detection in pixel space |
| `refiners.RefinerRegistry` / `RefinerPipeline` | Build and run the edge-refinement pipeline |
| `redaction_refiner.EtvRefiner` (plugin) | Wraps `SurroundingWordWidth.estimate_widths_for_boxes()` for context-aware x1/x2 refinement |
| `fitz` (PyMuPDF) | PDF parsing, text span extraction, image extraction |
| `collections.Counter` | Mode calculation for `suggested_size` |
