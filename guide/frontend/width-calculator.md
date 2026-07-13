# width_calculator.py

[width_calculator.py](https://github.com/JaguarM/Recto/blob/main/text_tool/logic/width_calculator.py) provides precision text-width measurement for candidate name matching.

---

## Functions

### `get_text_widths(texts, font_name, font_size, force_uppercase, scale_factor, kerning)`

Calculates pixel widths for a list of text strings.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `texts` | list[str] | — | Strings to measure |
| `font_name` | str | `"times.ttf"` | Font filename |
| `font_size` | int/float | `12` | Font size in **points** |
| `force_uppercase` | bool | `False` | Convert text to uppercase before measuring |
| `scale_factor` | float | `geo.DEFAULT_SCALE / 100` (≈ `1.333`) | Multiplier applied to the raw advance width (pt → image px) |
| `kerning` | bool | `True` | Enable OpenType `kern` feature |

**Output:**

```python
[{"text": "Hamburgefonstiv", "width": 89.472}, ...]
```

---

### Font Resolution

The font is searched in this order:

1. Direct path (`font_name` as-is)
2. `assets/fonts/{font_name}`
3. `assets/fonts/{font_name}.ttf`

System font directories are intentionally excluded to ensure consistent results across environments.

---

### HarfBuzz Engine (Primary)

When `uharfbuzz` is available:

```python
face = hb.Face(font_data)
font = hb.Font(face)
upem = face.upem   # units per em

buf = hb.Buffer()
buf.add_str(text)
buf.guess_segment_properties()

hb.shape(font, buf, features)

total_advance = sum(pos.x_advance for pos in buf.glyph_positions)
pixel_width = (total_advance / upem) * font_size * scale_factor
```

**Features controlled:**

| Feature | Enabled | Disabled |
|---------|---------|----------|
| `kern` | Default | `kerning=False` |

### Pillow Fallback

If HarfBuzz fails or is not installed, falls back to `ImageFont.truetype()` with `font.getlength()`. This method does not support fine-grained kerning control.

---

### `get_available_fonts()`

Scans the `assets/fonts/` directory and returns a list of `.ttf` filenames.

**Output:** `["times.ttf", "arial.ttf", ...]`

Used by the `/fonts-list` API endpoint to populate the frontend font dropdown.

---

## Scale Factor

`scale_factor` is the multiplier that converts a raw typographic advance (in font points) into the **image pixel width** used by the redaction overlay coordinates.

### Formula

```
pixel_width = (advance / upem) × font_size_pt × scale_factor
```

For the width to match a redaction box measured in the 816 × 1056 px embedded page images:

```
scale_factor = PAGE_WIDTH_PX / PAGE_WIDTH_PT
             = 816 / 612
             = 4/3
             ≈ 1.3333
```

This is equivalent to converting from 72 dpi (PDF points) to 96 dpi (screen pixels): `96 / 72 = 4/3`.

All of these constants — `PAGE_WIDTH_PX`, `PAGE_WIDTH_PT`, `PT_TO_PX`, and the
percentage form `DEFAULT_SCALE` — live in one place,
[`pdf_core/logic/geometry.py`](https://github.com/JaguarM/Recto/blob/main/pdf_core/logic/geometry.py)
(mirrored on the frontend as `window.GEO` in `text_tool/static/text_tool/geometry.js`).
Import them instead of re-deriving `816` / `612` / `0.75` in calling code.

### How the frontend sets scale_factor

The `/open-document` response includes `suggested_scale` (an integer percentage). `views.py` divides it by 100 before passing it to `get_text_widths()`:

```python
scale_factor = scale / 100.0   # e.g. 133 / 100 = 1.33
```

The auto-detected value `suggested_scale = 133` corresponds to `scale_factor ≈ 1.333`, which correctly maps 12 pt Times New Roman to its pixel width in the embedded page images.

> **Note:** The function signature's default is now `scale_factor = geo.DEFAULT_SCALE / 100` (≈ `1.333`), derived from the single geometry module rather than the old hardcoded `1.35` approximation. In normal operation the frontend always supplies an explicit scale (`GEO.docScale()`) from the `suggested_scale` auto-detection, so the default is rarely used.

For a full derivation of the correct scale value and why the old formula (`(median_size / 12) × (816/612)² × 100 ≈ 178`) was incorrect, see [Scale & Size Detection](../architecture/scale-and-size-detection.md).
