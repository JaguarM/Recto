# Scale & Size Detection

`load_pdf()` returns two auto-detected values that the frontend uses to pre-populate the width-calculator controls:

| Value | UI field | Purpose |
|-------|----------|---------|
| `suggested_scale` | **Scale %** | Converts typographic advance widths (in pt) to image pixel widths |
| `suggested_size` | **Font size** | Dominant body-text size found in the document (in pt) |

---

## `suggested_scale` — Derivation

### The width calculator formula

`width_calculator.py` computes:

```
pixel_width = (advance / upem) × font_size_pt × (scale / 100)
```

### What "pixel" means here

Redaction box coordinates live in the **embedded image's pixel space**. For scanned government document corpora, page images are always 816 × 1056 px, placed on a 612 × 792 pt PDF page (standard US Letter at 72 dpi):

```
image_px / page_pt = 816 / 612 = 4/3 ≈ 1.3333
```

This equals 96 dpi (the standard screen resolution) expressed as a ratio: `96 / 72 = 4/3`.

### Required scale

For the calculated width to match the redaction box width, the two expressions must be equal:

```
(advance / upem) × font_size_pt × (scale / 100)  =  (advance / upem) × font_size_pt × (img_px / page_pt)
```

The `(advance / upem) × font_size_pt` terms cancel, leaving:

```
scale / 100  =  img_px / page_pt
scale        =  round(100 × img_px / page_pt)
             =  round(100 × 816 / 612)
             =  133
```

### Why the old formula was wrong

The previous formula was:

```python
suggested_scale = round((median_size / 12.0) * (816 / 612) ** 2 * 100)  # → 178 for 12 pt
```

This squared the ratio `(816/612)`, producing ≈ 1.778 instead of 1.333. It also mixed font size into the scale, which double-counted the size correction already provided by passing `suggested_size` as the font size input. Both errors compounded, giving widths that were ~33% too wide on standard documents.

### Implementation

`load_pdf()` determines the ratio empirically from the first image it encounters, rather than hardcoding 816/612:

```python
page_scale_ratio = None

# ... inside image loop ...
if page_scale_ratio is None and img_rect.width > 0:
    page_scale_ratio = img_w / img_rect.width   # e.g. 816 / 612

# ... after loop ...
ratio = page_scale_ratio if page_scale_ratio is not None else geo.PT_TO_PX
suggested_scale = round(100 * ratio)   # → 133
```

`geo.PT_TO_PX` (`= 816/612 = 4/3`) and the percentage fallback `geo.DEFAULT_SCALE`
(`133`) both come from [`pdf_core/logic/geometry.py`](https://github.com/JaguarM/Recto/blob/main/pdf_core/logic/geometry.py),
the single source of truth for all page/DPI constants. This makes the formula
self-calibrating for non-standard page sizes or unusual scan resolutions.

> **Raw image uploads** (`process_image`) have no page geometry to measure, so
> they default to the same `geo.DEFAULT_SCALE` (133) as PDFs. (Earlier versions
> hardcoded `178` here, which assumed a ~128 dpi scan and disagreed with the
> 96-dpi PDF path; the two paths are now unified.)

---

## `suggested_size` — Derivation

### Goal

Find the dominant **body-text** font size so the width calculator uses the correct pt value. Headers, footers, page numbers, and labels tend to be short single words or numbers; paragraph text is longer.

### Algorithm

```python
def _body_sizes(spans, min_len):
    return [
        round(s["font"]["size"] * 2) / 2        # round to nearest 0.5 pt
        for s in spans
        if len(s.get("text", "")) >= min_len and s["font"]["size"] > 0
    ]

sizes = _body_sizes(text_spans, 20) or _body_sizes(text_spans, 1)
suggested_size = Counter(sizes).most_common(1)[0][0] if sizes else 12.0
```

**Step 1 — Prefer long spans.**
The 20-character threshold excludes short labels (e.g., "From:", "Page 1"). Paragraph text usually produces spans of several words concatenated. When long spans exist, only their sizes are considered.

**Step 2 — Fall back to all spans.**
Email documents and some word processors produce one span per word. If no span reaches 20 characters, the filter is relaxed to ≥ 1 character (all non-empty spans).

**Step 3 — Mode over median.**
Taking the median can return a size that bridges two distinct clusters (e.g., headers at 14 pt and body at 12 pt could produce a median of 13 pt). The mode always returns an actually-observed size, and it naturally favours whichever size appears most often in the document.

**Step 4 — Round to 0.5 pt.**
PyMuPDF returns sub-point sizes like `11.38`, `10.86`, `12.02`. These are rendering artifacts; the original font size is almost always a whole or half-point value. Rounding `× 2 / 2` snaps each span's size to the nearest 0.5 pt before the frequency count, so `10.86`, `10.90`, and `10.94` all vote for `11.0` rather than splitting into three separate bins.

### How the frontend uses these values

```js
// pdf-viewer.js — on PDF load
els.calcScale.value = data.suggested_scale || GEO.DEFAULT_SCALE;  // e.g. 133
els.size.value      = data.suggested_size  || 12;                 // e.g. 12.0 (pt)

// Each redaction is initialised with these settings:
settings: { font: ..., size: autoSize, scale: autoScale, ... }
```

When the user triggers a width calculation, both values flow to the backend `/widths` call:

```
pixel_width = (advance / upem) × suggested_size × (suggested_scale / 100)
            = (advance / upem) × 12.0 × 1.33
            = (advance / upem) × 12.0 × (816/612)
```

which exactly reproduces the image-space pixel width of that text.

---

## Summary

| Parameter | Value (standard letter) | Formula |
|-----------|------------------------|---------|
| `suggested_scale` | **133** | `round(100 × img_w_px / page_w_pt)` |
| `suggested_size` | e.g. **12.0** | mode of span sizes ≥ 20 chars (falls back to all spans), rounded to 0.5 pt |
