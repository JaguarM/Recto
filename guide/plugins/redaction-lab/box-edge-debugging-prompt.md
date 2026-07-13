# Session Prompt — Debugging Redaction Box Edge Placement

Paste this into a new session when working on redaction **box width / edge
placement** accuracy. It captures the architecture, the debugging method that
worked, the verified ground-truth facts, and copy-paste repro scripts.

---

## ⚡ There is now a tool — use it instead of pasting scripts A–D

`python -m pdf_core.logic.debug.debug_width`
([pdf_core/logic/debug/debug_width.py](../../pdf_core/logic/debug/debug_width.py))
reproduces the real refiner on any page and bundles everything below into one
command. It loads the page through the **same** `detect.extract_page_image`
helper the server uses (no pixel drift) and reads the refiner's **real**
intermediates via the opt-in `estimate_widths_for_boxes(..., debug_out=[])`
channel (no re-derived maths).

```bash
python -m pdf_core.logic.debug.debug_width --page 8            # ground-truth case
python -m pdf_core.logic.debug.debug_width --page 8 --pixels   # + ASCII map & column stats (scripts B/C)
python -m pdf_core.logic.debug.debug_width --pdf <path> --page 3 --box 0
python -m pdf_core.logic.debug.debug_width --verify            # regression check (script in "Verify" below)
```

Per box it prints the **three competing edges** — raw ink, pixel content edge,
and *neighbour-by-pixels ∓ one space* (the text-geometry estimate you want to
trust) — plus the ETV width-change guard and the final pipeline box. It auto-saves
to `debug_out/`: a whole-page overview and an upscaled crop per box with every
candidate edge drawn (blue=raw ink, red=refined, orange=content, green=text-geo,
yellow=text-layer claim). `Read` those PNGs to view them.

The hand-written scripts A–D below still document the underlying steps; reach for
them only when you need something the tool doesn't surface.

---

## Task framing

Redaction boxes are detected as solid black rectangles on a rendered page, then
their left/right edges are refined so `box.width` matches the **true extent of
the redacted name** (for matching against candidate name widths). Bugs show up
as the placed box being a few px too wide or too narrow on one edge.

All coordinates live in a **fixed 816×1056 px space**. There is no extra scaling
between the Python output and the rendered box — `pdf-viewer.js` uses `x=r.x,
w=r.width` directly.

## Pipeline (read these first, in order)

1. [pdf_core/logic/BoxDetector.py](../../pdf_core/logic/BoxDetector.py)
   — row-by-row scan for pure-black (`< 10`) rectangles. Returns
   `(x1, y1, x2, y2)` per box. **`x2`/`y2` are EXCLUSIVE** (one past the last
   black pixel). Min box 17×10 px. Filters hole-punches (tapered) and
   T/cross intersections.
2. [pdf_core/logic/detect.py](../../pdf_core/logic/detect.py)
   — `process_pdf(pdf_bytes)`. Extracts the embedded PNG per page, **crops it to
   the 8.5×11 ratio** (`expected_h = round(w*1056/816)`), runs BoxDetector, wraps
   each raw box in a `DetectedBox`, runs the refiner pipeline, emits
   `redactions: [{page,x,y,width,height,area}]`.
3. [pdf_core/logic/refiners/pipeline.py](../../pdf_core/logic/refiners/pipeline.py)
   — `RefinerPipeline.run(box, evidence)`. Collects each refiner's `BoxProposal`
   (per-edge `x`, `x2`, `confidence`), merges edge-by-edge, highest confidence
   wins; on tie keep the wider edge. Proposals may sit slightly outside the ink
   (poking glyph) or inside it — the **refiner** is responsible for trustworthy
   edges, not the pipeline.
4. [redaction_refiner/etv_refiner.py](../../redaction_refiner/etv_refiner.py)
   — wraps `estimate_widths_for_boxes`. Has a `_max_width_change = 0.25` guard
   (rejects proposals changing width > 25 %). Confidence `0.9`. Lives in the
   `redaction_refiner` plugin and self-registers via `@register_refiner`;
   `detect` builds its pipeline from `RefinerRegistry`.
5. [pdf_core/logic/SurroundingWordWidth.py](../../pdf_core/logic/SurroundingWordWidth.py)
   — **the real edge logic.** `estimate_widths_for_boxes(page, boxes, img_rect,
   img_w, img_h, base_image_bytes)`. Buckets page words into lines, finds the
   `word_before`/`word_after` neighbours, then computes pixel-accurate edges
   (see "current algorithm" below).
6. Frontend: [redaction_matching/static/redaction_matching/api.js](../../redaction_matching/static/redaction_matching/api.js)

## Coordinate conversion (used constantly)

```python
px_to_pts_x = img_rect.width / img_w     # 0.75 in the test PDF (612pt / 816px)
pts_to_px_x = 1.0 / px_to_pts_x          # 1.3333...
word_px = (word_pt - img_rect.x0) * pts_to_px_x
```

## Ground-truth test case (verified — reuse it)

- PDF: `assets/pdfs/times/efta00018586.pdf`, **page 8** (`doc[7]`, page_index 7).
  It has 9 pages, only 2 redaction boxes (both on page 8).
- Line text: `SMITH, including ░░░░░░░░░ and JANE DOE.`
- **Box 1 hides "Sarah Kellen"**, true rendered width **≈ 120.79 px**.
- Black-ink extent (BoxDetector raw): **x1 = 235, x2 = 356** (cols 235‑355 are
  pure black; col 356 is the AA edge; `x2=356` exclusive).
- The redaction covers the **"a" of "and"**, so PyMuPDF's text layer reports the
  **fragment "nd"** at `x0 = 363.85 px`, NOT "and". The visible "a" ink starts at
  **col 358** (col 357 is the inter-word gap). → **The text layer's word-after
  position is wrong here; you must locate the next word by PIXELS.**
- The **"S" of Sarah pokes ~2 px left of the ink** (cols 233‑234 contain the S
  curve; col 234 strong, col 233 faint ~150; col 232 white).
- The box's right edge (356) **overruns the name end into the trailing space**
  before "and".

Expected refined result: **x1 ≈ 233.16, x2 ≈ 353.9, width ≈ 120.76** (off 120.79
by ~0.03 px). Box 2 lands at **x1 ≈ 320.26, width ≈ 120.68** (off ~0.11 px).

> **Sub-pixel edge** (`_subpixel_glyph_edge`): a visible poke covers its outer
> column only fractionally (the "S" reaches col 233 at ~40 % ink, full ink at
> col 234), so once `_content_edge` has absorbed a *validated* poke it places the
> edge at the 50 %-ink crossing of the column's darkest row instead of the
> integer column. That moved box 1 from 120.9 → **120.76**. It only fires on a
> column the glyph test accepted, so the box's full-height AA edge is never
> sub-pixel'd.
>
> **Box 2 AA fringe** (`_box_aa_edge`): box 2's leading "S" is *fully under the
> paint* (col 319 white, col 320 a full-height grey ~66/255, col 321 black), so
> there is no poke. But BoxDetector thresholds at pure black (`< 10`), so it drops
> the box's own anti-aliased edge column (320) and reports the left edge a pixel
> narrow at 321. When no glyph pokes out, the box edge is the best proxy for the
> snugly-covered name edge, so `_content_edge` extends across that single
> full-height grey fringe to its sub-pixel ink-coverage position
> (321 − 66/255-coverage ≈ **320.26**). That moved box 2 from 119.94 → **120.68**
> (off 120.79 by ~0.11). It fires only on a single full-height grey column with
> paper beyond it (never a partial-height glyph), and is clamped outward by
> neighbour∓space, so it can't run the box wide.

## Key insights (the things that were non-obvious)

1. **`x2` is exclusive.** Don't off-by-one the right edge.
2. **The text layer lies when a redaction eats a neighbouring letter.** "and" →
   "nd" shifted right. Subtracting a space from the fragment's left edge
   overshoots into whitespace. Always cross-check word positions with pixels.
3. **A box's own anti-aliased edge is as dark as ink** (e.g. right AA col = 52),
   so darkness alone can't tell glyph from box edge.
4. **Redaction boxes are painted TALLER than the text.** So the discriminator
   that works: a **glyph darkens only part of the column height** (the text
   rows), while the **box edge darkens the full column**. Use the *dark-pixel
   fraction* of the column, not pixel darkness or variance.
   (Variance also works but the faint S edge sat at std 39.7 vs a 40 threshold —
   too close. Dark-fraction had clean margins: glyph 5–6/24 rows vs box 24/24.)
5. **The name end on an overrun edge is hidden under the paint** and cannot be
   read directly. Reconstruct it as `next_word_pixel_edge ∓ one_space`.
6. Take the edge as the **innermost of** (pixel content edge incl. poking glyph)
   and (neighbour ∓ space): a poking glyph still wins (it is real ink) while a
   box that overran the gap gets pulled back.

## Current algorithm in SurroundingWordWidth.py

Per box, on the chosen text line:
- `space_px` = mean inter-word gap on the line, clamped to [3, 8] (≈ 4.1 here).
- `left_bound`/`right_bound` = neighbour word near edges in px (text layer).
- `content_x1/x2 = _content_edge(...)`: from each ink edge, walk OUTWARD absorbing
  columns where `_is_glyph_col` is true (poking glyph + its faint fringe), stop at
  the first non-glyph column (box AA or whitespace). Never cross the bound.
- `nbr_l/nbr_r = _next_word_edge(...)`: from the content edge, scan across the gap
  and return the **next word's near ink edge by pixels** (skips the box's own
  full-height AA via the same `_is_glyph_col`).
- `expected_x1 = max(content_x1, nbr_l + space_px)`
  `expected_x2 = min(content_x2, nbr_r - space_px)`
- `_is_glyph_col(col)`: `min_dark ≤ count(col < 160) < 0.8 * len(col)`
  (dark in some rows but not the whole column → a letter, not the box edge).

## The debugging method that worked (do this, don't theorise)

**Reproduce on the real PDF and LOOK AT PIXELS.** Hypothesising about the math
was misleading every time; the pixel dumps settled it immediately.

1. **Instrument the pipeline** — run BoxDetector + the refiner on page 8 and print
   raw box, ETV proposal, and final width (script A below).
2. **ASCII pixel map** of each edge — `.`/`:`/`#` by threshold, to see letters
   vs box vs whitespace (script B).
3. **Raw grayscale column dump** + per-column `min`, `std`, `count(<thresh)` to
   pick thresholds with real margins (script C).
4. **Render crops with PIL** at 3–16× and draw the refined box in red to confirm
   visually (script D). Use the Read tool on the saved PNG to view it.

Standard image load (matches detect' crop) used by all scripts:

```python
import fitz, numpy as np
from io import BytesIO
from PIL import Image
doc = fitz.open('assets/pdfs/times/efta00018586.pdf'); page = doc[7]
xref = doc.get_page_images(7)[0][0]
img_bytes = doc.extract_image(xref)['image']
with Image.open(BytesIO(img_bytes)) as p:
    if p.mode not in ('RGB','RGBA','L'): p = p.convert('RGB')
    w,h = p.size; eh = int(round(w*(1056.0/816.0)))
    if h > eh: p = p.crop((0,0,w,eh))           # crop to 8.5x11 like the server
    rgb = p.convert('RGB'); arr = np.array(p.convert('L'))
```

> Note: `etv_refiner.py` imports `pdf_core.logic.SurroundingWordWidth`, so run
> scripts from the repo root with `sys.path.insert(0, os.getcwd())` (not from
> inside `pdf_core/logic`).

### Script A — run the real refiner pipeline

```python
import sys, os; sys.path.insert(0, os.getcwd())
import fitz
from io import BytesIO
from PIL import Image
from pdf_core.logic.BoxDetector import find_redaction_boxes_in_image
from pdf_core.logic.refiners.pipeline import RefinerPipeline
from redaction_refiner.etv_refiner import EtvRefiner
from pdf_core.logic.refiners.base import DetectedBox
pipe = RefinerPipeline([EtvRefiner()])
doc = fitz.open('assets/pdfs/times/efta00018586.pdf'); page = doc[7]
xref = doc.get_page_images(7)[0][0]
img_bytes = doc.extract_image(xref)['image']
with Image.open(BytesIO(img_bytes)) as p:
    w,h = p.size; eh = int(round(w*(1056.0/816.0)))
    if h > eh:
        p = p.crop((0,0,w,eh)); out = BytesIO(); p.save(out,format='PNG'); img_bytes = out.getvalue()
boxes,img_w,img_h = find_redaction_boxes_in_image(img_bytes)
img_rect = page.get_image_rects(xref)[0]
ev = {'etv': {'page':page,'img_rect':img_rect,'img_w':img_w,'img_h':img_h,'img_bytes':img_bytes}}
for bx1,by1,bx2,by2 in boxes:
    d = DetectedBox(page=8, x=float(bx1), y=float(by1), width=float(bx2-bx1), height=float(by2-by1))
    r = pipe.run(d, ev)
    print(f'RAW {bx1}->{bx2} w{bx2-bx1}  REFINED x1={r.x:.2f} x2={r.x+r.width:.2f} w={r.width:.2f}')
```

### Script B — ASCII pixel map of an edge

```python
# after the standard load above (gives `arr`)
for y in range(680, 708):
    row = ''.join('#' if arr[y,x] < 80 else (':' if arr[y,x] < 200 else '.')
                  for x in range(225, 245))     # cols around the LEFT edge
    print(f'{y}: {row}')
```

### Script C — raw values + per-column stats

```python
for x in range(232, 240):
    col = arr[682:706, x]
    print(f'col {x}: min={col.min():3d} std={col.std():5.1f} dark(<160)={int((col<160).sum())}/{len(col)}')
```

### Script D — render + draw refined box (then Read the PNG)

```python
from PIL import ImageDraw
draw = ImageDraw.Draw(rgb)
draw.rectangle([233.0, 680, 353.9, 708], outline=(255,0,0), width=1)
c = rgb.crop((150,672,420,714)); c = c.resize((c.width*3, c.height*3), Image.NEAREST)
c.save('/tmp/out.png')          # then use the Read tool on /tmp/out.png
```

## Tuning knobs (in SurroundingWordWidth.py)

- `_is_glyph_col`: `dark_thresh=160` (catches faint AA fringe of a glyph),
  `min_dark_px=2`, `max_dark_frac=0.8` (reject the full-height box edge).
- `space_px` clamp `[3, 8]`; neighbour search margin `±6 px` past the text bound,
  or `±14 px` when there is no neighbour word.
- Vertical scan band is inset `by1+2 .. by2-2` to skip the box's own corners.

## Verify after any change

```bash
python -c "import sys,os; sys.path.insert(0,os.getcwd()); \
from pdf_core.logic.detect import process_pdf; \
print([{k:round(v,2) for k,v in r.items() if k in ('x','width')} \
for r in process_pdf(open('assets/pdfs/times/efta00018586.pdf','rb').read())['redactions']])"
# expect ~ x=233.16 width=120.76  and  x=320.26 width=120.68  on page 8
```

There are **no unit tests** in `pdf_core/tests.py`; verify by reproducing on
the PDF and eyeballing the rendered red box. Clean up any `/tmp/*.py` and
`/tmp/*.png` scratch files when done.

## History of fixes already applied (don't redo)

1. ETV was overshooting the **right** edge: it did `word_after_left − space`, but
   `word_after` was the fragment "nd", landing in whitespace past the ink.
2. First fix clamped edges to the ink — but that **cut off the poking "S"**.
3. Final fix = the pixel algorithm above: poking-glyph detection by dark-fraction
   + next-word-by-pixels + `innermost(content, neighbour∓space)`. Pipeline
   reverted to a plain confidence merge (refiner owns edge correctness).
