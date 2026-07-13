# SurroundingWordWidth.py Documentation

[`pdf_core/logic/SurroundingWordWidth.py`](../../pdf_core/logic/SurroundingWordWidth.py)
refines the **horizontal edges** of detected redaction boxes by reconstructing
where the hidden text actually started and ended in the original Microsoft Word
source. It combines two kinds of evidence:

1. **Pixel evidence** — the painted box edge, any glyph of the hidden text that
   pokes past the paint, and the near edge of the neighbouring visible word.
2. **Word-grid evidence** — Word lays text on a predictable grid (¼-inch indents
   and tab stops, a 1-inch default margin) and stretches inter-word spaces on
   justified lines. The left edge is snapped/spaced to match that grid.

It is wrapped by the [`EtvRefiner`](../../redaction_refiner/etv_refiner.py)
plugin; the core orchestrator never calls it directly (see
[detect](process-redactions-docs.md) and the refiner architecture in
[architecture-overview](../architecture/architecture-overview.md)).

All canonical geometry is **image pixels @ 96 DPI**. The constants
(`GRID_PX = 24`, `DEFAULT_MARGIN_PX = 96`, `JUSTIFY_SPACE_TOL_PX`, the gap-filter
ranges) live in [`geometry.py`](../../pdf_core/logic/geometry.py).

---

## Core Function

### `estimate_widths_for_boxes(page, boxes, img_rect, img_w, img_h, base_image_bytes=None, debug_out=None)`

**Inputs:**
- `page` — a `fitz.Page` (PyMuPDF); used for `get_text("words")` and
  `get_text("dict")` (font/size of each line).
- `boxes` — list of `(x1, y1, x2, y2)` tuples in **image pixel** coordinates
  (from BoxDetector).
- `img_rect` — `fitz.Rect` of the embedded image on the PDF page (PDF points).
- `img_w`, `img_h` — pixel dimensions of the source image.
- `base_image_bytes` — optional raw PNG bytes. When present, edges are validated
  and refined against the actual pixels; when absent, pixel scans degrade to the
  raw box edge.
- `debug_out` — optional list. When provided, one dict of per-box intermediates
  is appended for each input box (see [Debug output](#debug-output)). Default
  `None` keeps production cost unchanged; only the width debugger passes it.

**Output:**
A list of `(expected_x1, expected_x2, expected_height)` tuples, one per input
box, all in image pixels. Any element is `None` when that value could not be
reconstructed. `expected_height` is the line's mean word height (used elsewhere
for vertical snapping); the refiner consumes only `expected_x1`/`expected_x2`.

---

## Algorithm

### 1. Coordinate conversion

```python
px_to_pts_x = img_rect.width / img_w        # 0.75 on a standard 612pt / 816px page
pts_to_px_x = 1.0 / px_to_pts_x             # 1.333…
```

Each box is converted to point coordinates for comparison against the text
layer. The page text layer (`get_text("words")`) is read once, as is a flattened
list of spans (`get_text("dict")`) used to recover each line's font and size.

### 2. Word bucketing by line

For each box, the page words are grouped into horizontal "line buckets":
- a word joins the box's line if **≥ 50 %** of its height overlaps the box
  vertically;
- words within **5 pts** of the same y-midpoint share a bucket.

> The buckets include words sitting **under** the redaction — the pixel paint
> hides the ink but the PDF text layer survives — which is what makes the
> justification rewrite (step 4) possible.

### 3. Nearest words (before / after)

In each bucket the algorithm picks:
- **`word_before`** — the word whose right edge is closest to, and left of, the
  box's left edge;
- **`word_after`** — the word whose left edge is closest to, and right of, the
  box's right edge.

A neighbour is rejected if another redaction box lies between it and the current
box on the same line (**obstruction detection**), so a measurement never reaches
through an intervening redaction. The best bucket maximises the match count
(prefer both sides), then minimises total distance.

If **no** bucket yields a neighbour, the box is *isolated* — see
[Isolated boxes](#isolated-boxes-no-line-context).

### 4. Space reconstruction (the Word grid)

Three space-related quantities are computed for the chosen line:

| Quantity | Source | Used for |
|----------|--------|----------|
| `measured_gap` | mean of inter-word pixel gaps kept inside `GAP_FILTER_RANGE` (3–11 px) | justification test; the stretched space on a justified line |
| `natural_space` | HarfBuzz-shaped advance of `" "` in the line's font/size (via [`width_calculator.get_text_widths`](width-calculator-documentation.md)) | the space after a word on a normal line |
| `space_px` | `measured_gap` clamped to `SPACE_PX_CLAMP` (3–8 px), `SPACE_PX_FALLBACK` (5 px) if none | the **right** edge, and the fallback when shaping is unavailable |

**Justification test.** A line is treated as justified when the *measured* gap
exceeds the font's natural space by more than `JUSTIFY_SPACE_TOL_PX`:

```python
is_justified = (measured_gap is not None and natural_space is not None
                and measured_gap > natural_space + geo.JUSTIFY_SPACE_TOL_PX)
```

The space used for the **left** edge is then:

```python
if is_justified:    word_space_px = measured_gap     # stretched (bounded by GAP_FILTER_RANGE)
elif natural_space: word_space_px = natural_space     # one natural space
else:               word_space_px = space_px          # pixel-gap fallback
```

> **Why the measured gap, not a fill-width solve?** `width_calculator` also
> exposes `get_justified_space_width()` (solve for the per-space width that makes
> the line fill its block). In this corpus the text layer *under* a redaction is
> often fragmented, which makes that solve explode (e.g. a 40 px "space" against
> a 3.8 px natural space) and can push the edge *into* the box. The measured
> inter-word gap between real visible words is bounded and reliable, so the solve
> is computed for the debug stream only and does **not** drive placement.

**First-word grid offset.** In Word the line's first word (the paragraph origin)
sits on a ¼-inch grid line. Its left edge is snapped to the grid and the
resulting correction is carried along the line:

```python
first_word_x0_px = (best_line_words[0][0] - img_rect.x0) * pts_to_px_x
grid_origin_px   = round(first_word_x0_px / geo.GRID_PX) * geo.GRID_PX
grid_offset      = grid_origin_px - first_word_x0_px        # bounded to ±½ grid cell
```

### 5. Left-edge placement

```python
content_x1 = _content_edge(...)          # box ink + any poking glyph
nbr_l      = _next_word_edge(...)         # previous word's far edge, by pixels
grid_x1    = round(content_x1 / geo.GRID_PX) * geo.GRID_PX

if word_before is None:
    # No text in front: the box itself is the first thing on the line, so its
    # true start is a grid line. Snap the painted edge to the nearest grid line
    # (origin = page left edge). The render can drift; the grid matches the source.
    expected_x1 = grid_x1
else:
    # Text in front: start one (natural or stretched) space after that word's
    # far edge, re-anchored to the grid by the line's first-word offset. max()
    # never lets the result sit inside real ink (keeps a poking glyph).
    expected_x1 = content_x1
    if nbr_l is not None:
        expected_x1 = max(content_x1, nbr_l + word_space_px + grid_offset)
```

The result is *not* grid-snapped in the word-before case: only the line's first
word is grid-aligned in Word; a mid-line hidden word is positioned by spacing
relative to that origin.

### 6. Right-edge placement

Unchanged by the grid work — the right edge is `min(content_x2, nbr_r - space_px)`
when a following word exists, else the painted content edge.

### Isolated boxes (no line context)

When step 3 finds no neighbour on any candidate line, the box is isolated. Rather
than abstaining, the **left** edge is still snapped to the grid (an isolated
redaction in Word also began on a grid line), and the right edge abstains:

```python
content_x1  = _content_edge(img, bx1, -1, y0_scan, y1_scan, 0.0)
expected_x1 = round(content_x1 / geo.GRID_PX) * geo.GRID_PX        # nearest grid line
```

---

## Pixel-edge helpers

These resolve the painted edge and the neighbouring word from the raster. Each
takes the grayscale image, scans a vertical band inset by 2 px from the box top
and bottom, and is bounded so it can never cross into a neighbouring word.

| Helper | Role |
|--------|------|
| `_is_glyph_col(col)` | True if a column looks like letter ink (darkens some rows) rather than a full-height box edge or blank paper. |
| `_content_edge(img, ink_edge, dir, y0, y1, bound)` | Walk outward through contiguous glyph ink to absorb a glyph that pokes past the paint; otherwise recover the box's own anti-aliased fringe. |
| `_subpixel_glyph_edge(...)` | Refine an absorbed poke to its sub-pixel 50 %-ink crossing. |
| `_box_aa_edge(...)` | When no glyph pokes, extend the edge across the box's anti-aliased fringe that BoxDetector trimmed. |
| `_next_word_edge(img, start, dir, y0, y1, bound)` | Scan across the inter-word whitespace to the **pixel** near-edge of the next word — found from ink because the text layer under a box may report only a fragment. |

## Font helpers

| Helper | Role |
|--------|------|
| `_collect_spans(page)` | Flatten `page.get_text("dict")` to `(bbox, font_name, size_pt)`. |
| `_line_font(spans, line_words)` | Dominant `(ttf, size_pt)` for the spans covering a line. |
| `_map_font(pdf_font_name)` | Map a PDF base-font name (e.g. `TimesNewRomanPSMT`) to a TTF in `assets/fonts/`; defaults to `times.ttf`. |
| `_line_space_widths(...)` | Returns `(natural_space, justified_space)`; the justified value is debug-only (see step 4 note). |

---

## Debug output

When `debug_out` is passed, each matched box appends a dict with the raw and
reconstructed intermediates:

`raw_ink`, `line_words`, `word_before`, `word_after`, `left_bound`,
`right_bound`, `space_px`, `gaps`, `y_scan`, `content_x1`, `content_x2`,
`nbr_l`, `nbr_r`, `expected_x1`, `expected_x2`, and the Word-grid fields:
`font`, `size_pt`, `block_w_px`, `measured_gap`, `natural_space`,
`justified_space`, `is_justified`, `word_space_px`, `grid_x1`,
`first_word_x0_px`, `grid_origin_px`, `grid_offset`, `word_before_present`.

Isolated boxes append `reason`, `content_x1`, `grid_x1`, `expected_x1`,
`word_before_present=False`. See
[box-edge-debugging-prompt](box-edge-debugging-prompt.md) for the harness.

---

## Constraints & parameters

| Parameter | Source | Value | Purpose |
|-----------|--------|-------|---------|
| Vertical overlap threshold | inline | 50 % | min word-box vertical overlap to share a line |
| Line bucket tolerance | inline | 5 pts | max y-midpoint distance to group words |
| `GAP_FILTER_RANGE` | geometry.py | 3–11 px | raw inter-word gaps kept before averaging |
| `SPACE_PX_CLAMP` | geometry.py | 3–8 px | clamp on the per-line mean gap (right edge / fallback) |
| `SPACE_PX_FALLBACK` | geometry.py | 5 px | mean gap assumed when none is measurable |
| `GRID_PX` | geometry.py | 24 px | ¼-inch Word grid step (origin = page left edge) |
| `DEFAULT_MARGIN_PX` | geometry.py | 96 px | Word's default 1-inch left margin (grid index 4) |
| `JUSTIFY_SPACE_TOL_PX` | geometry.py | 1.5 px | per-space stretch over natural that marks a justified line |

---

## Downstream

`EtvRefiner` turns the returned edges into a `BoxProposal(x, x2,
confidence=0.95, source="etv")`. Its width guard rejects an edge only when the
width change exceeds **`max(25 % of the box width, GRID_PX)`** — the one-grid-cell
floor means a bounded grid snap on a small box is never silently dropped, while a
wild ETV expansion is still caught. The pipeline merges edges by confidence
(highest wins; ties prefer the wider box), so the 0.95 grid/justification edge
overrides a lower-confidence pixel edge.

## Known limitations / future work

- **Wide justified spaces** beyond `GAP_FILTER_RANGE` (11 px) are filtered out,
  so a heavily justified line can under-stretch. Raising the cap risks admitting
  box-spanning gaps; a justified-aware upper bound would be safer.
- **Isolated/no-word snap uses *nearest* grid line**, which can move the edge
  right and (slightly) reveal hidden ink. A "nearest at-or-left" mode would be
  safer for live redaction at the cost of grid fidelity.
- **First word redacted**: if the line's first word is itself a fragment under a
  box, `grid_offset` is computed from a wrong baseline (still bounded to ±½ cell).
- **Grid origin is the page edge**, which coincides with a 1-inch margin (96 is a
  multiple of 24). A document with a non-grid margin would need detected-margin
  origin instead.
