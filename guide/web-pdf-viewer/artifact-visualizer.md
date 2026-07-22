# Artifact Visualizer — Documentation

`webgl_mask/logic/artifact_visualizer.py`

---

## Overview

The artifact visualizer detects black redaction boxes embedded in PDF pages and generates grayscale mask PNGs that the WebGL overlay layer uses to highlight or subtract those regions in the browser.

**Pipeline summary:**

```
PDF bytes
  └─ generate_all_masks()           ← webgl_mask views.py
       └─ find_redaction_boxes_in_image()   ← detect pure-black rectangles
            └─ build mask array + edge borders
                 └─ returned as bytes (web) or saved to disk (CLI)
```

---

## Constants

| Name | Value | Purpose |
|------|-------|---------|
| CLI input | first argument, else the startup PDF (`find_default_document()`) | Input path for CLI mode |
| `PAGE_W` | `816` | Reference page width in pixels |
| `PAGE_H` | `1056` | Reference page height in pixels |

The mask is generated at the source image's native resolution.

---

## `find_redaction_boxes_in_image(image_bytes)`

**Input:** raw image bytes (any PIL-readable format)
**Output:** `(boxes, img_w, img_h)`
- `boxes` — list of `(x1, y1, x2, y2)` tuples in source-image pixel space
- `img_w`, `img_h` — dimensions of the source image

### What counts as a redaction box

A pixel must be **exactly** `R=0, G=0, B=0` (pure black). No tolerance. The detected rectangle must be at least **17 px wide** and **10 px tall**.

### Detection algorithm — row-by-row run tracking

The algorithm scans the image one row at a time. It never converts to grayscale; it works directly on the RGB array.

**Step 1 — Black pixel mask**

```python
mask = (r == 0) & (g == 0) & (b == 0)
```

This produces a 2D boolean array the same size as the image.

**Step 2 — Run detection per row**

For each row, contiguous runs of `True` pixels are found using `np.diff` on a padded version of the row. Only runs ≥ 17 px wide are kept as `current_segments`.

**Step 3 — Active run tracking across rows**

`active_runs` is a dict keyed by `(sx, ex)` — the x-span of a run when it first started. Each entry stores:
- `start_y` — the row where this run began
- `history` — list of `(csx, cex)` x-spans observed on each subsequent row

A run **survives** into the next row if a current segment mostly contains it (±2 px tolerance on each side). The history records the actual x-span each row so that tapered shapes can be measured.

A run **dies** (becomes a candidate box) when no current segment contains it. At that point:
- Height `h = current_row - start_y` must be ≥ 10
- The **core span** is computed: `core_x = max of all left edges`, `core_ex = min of all right edges` — this is the narrowest consistent width across the entire run, filtering out one-row wider sections
- Core width must still be ≥ 17 px

**Step 4 — Taper filter (circle/hole-punch rejection)**

Circular hole-punches in paper taper on both top and bottom. The filter checks the row just above the start and just below the end:

```
missing_top  = width - count_of_black_pixels_on_top_edge_row
missing_bottom = width - count_of_black_pixels_on_bottom_edge_row
```

If **both** `missing_top ≤ 30%` and `missing_bottom ≤ 30%`, the shape is rejected. A true rectangle has full-width top and bottom edges (missing ≈ 0%), while a circle is narrow at both ends.

**Step 5 — Flush remaining active runs at end of image**

Any run still active after the last row is flushed with `missing_bottom = width` (forced full missing, so only tapered-top shapes with a flat bottom get rejected).

**Step 6 — `clean_overlapping_boxes`**

Handles T-shaped intersections (e.g., a vertical bar meeting a horizontal bar). If box B:
- starts during box A's vertical extent
- horizontally contains A (±2 px)
- is significantly wider than A (≥ 10 px wider)
- ends at roughly the same y as A (±5 px)

...then A's bottom is trimmed to where B starts. This separates the vertical stem from the horizontal bar of a T.

After cleaning, boxes are deduplicated and sorted by `(y, x)`.

---

## `create_redaction_masks(pdf_path)`

CLI entry point. Processes every page of a PDF file and saves mask PNGs to disk.

**Output filenames:** `{pdf_basename}_mask_p{page_num}.png`

### Per-page process

1. **Extract image** — calls `extract_page_image_bytes(doc, page_index)` which pulls an embedded raster image from the PDF page (does not re-render the PDF via fitz).

2. **Detect boxes** — calls `find_redaction_boxes_in_image()`.

3. **Build grayscale rendered array** — opens the same image bytes and converts to `"L"` (8-bit grayscale). This is used only for the edge border calculation.

4. **Build mask array** — `np.zeros((img_h, img_w), dtype=np.uint8)`. Convention:
   - `0` = unredacted (black in PNG)
   - `255` = fully redacted (white in PNG)

5. **Fill boxes + borders** — see [Mask Construction](#mask-construction) below.

6. **Save** — save as PNG at native resolution.

---

The mask construction logic is identical to `generate_mask_from_image`.

---

## `generate_all_masks(pdf_bytes)`

Batch processes an entire PDF and returns an array of base64-encoded mask strings (or `null` for pages without redactions). Used by the `/webgl/masks` endpoint for async frontend loading.


---

## Mask Construction

### Interior fill

```python
mask[y1:y2, x1:x2] = 255
```

Every pixel inside the detected bounding box is set to 255 (fully redacted).

### 1-pixel border — uniform edge shading

For each of the four edges of each box, a 1-pixel strip **outside** the box is filled with a single uniform gray value:

```python
shade = int(np.max(rendered[y1 - 1, x1:x2]))   # top edge
mask[y1 - 1, x1:x2] = np.maximum(mask[y1 - 1, x1:x2], shade)
```

`shade` is the **lightest pixel** (maximum luminance) found anywhere along that edge in the source image. The entire 1 px strip gets that single value.

**Why the lightest pixel?**
The strip outside a redaction box can contain a mix of paper (light) and letter strokes (dark). Using the maximum ensures that paper-adjacent edges get a high shade value (≈ 255, near-white) while edges that are surrounded entirely by dark content get a lower shade. `np.maximum` prevents overwriting a higher value already written by an adjacent overlapping box.

Bounds are checked before each edge write (`y1 > 0`, `y2 < img_h`, `x1 > 0`, `x2 < img_w`) to avoid out-of-bounds writes.

### Mask value semantics

| Value | Meaning | WebGL alpha (via `maskVal * uOpacity`) |
|-------|---------|----------------------------------------|
| `0` | Unredacted / outside box | 0 — fully transparent |
| `1–254` | Edge border (uniform per edge) | Proportional — light brightening |
| `255` | Redacted interior | `uOpacity` — full effect |

The WebGL fragment shader reads `maskVal` (0.0–1.0) directly as the alpha factor, so lighter edge shades produce proportionally stronger screen-blend brightening.

---

## WebGL Integration

The mask PNG is served by the Django backend at `/webgl/masks` and loaded as a `LUMINANCE` texture in [webgl-mask.js](../../webgl_mask/static/webgl_mask/webgl-mask.js).

Fragment shader reads:
```glsl
float alpha = maskVal * uOpacity;
vec3 invColor = 1.0 - uColor;
gl_FragColor = vec4(invColor * alpha, alpha);
```

Combined with `mix-blend-mode: screen` on the canvas element, this makes:
- **White mask color** → inverted to black → screen with black = no change
- **Black mask color** → inverted to white → screen brightens the PDF

The `uOpacity` uniform is driven by the "Mask Opacity" slider (0–255 → 0.0–1.0).

---

## CLI Usage

```bash
python webgl_mask/logic/artifact_visualizer.py
```

Reads `PDF.pdf` from the working directory and writes one PNG per page that contains redactions.

---

## Known Constraints

- **Pure black only** — pixels with RGB `(1,1,1)` or any near-black value are not detected. This is intentional to avoid false positives from dark text.
- **Minimum size** — boxes smaller than 17×10 px are ignored.
- **Single-image pages** — `extract_page_image_bytes` extracts the first embedded raster image from each page. Pages with no embedded image or only vector content produce no mask.
