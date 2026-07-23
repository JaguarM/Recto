# SVG Text Layer — `svg-renderer.js` + `unified-text-box.js`

The SVG text layer replaces the old DOM-span system. All text on the page — extracted PDF text, manually added boxes, and HarfBuzz recreations — is rendered as SVG `<text>` elements in a per-page `<svg class="text-layer">` that sits directly over the page image.

---

## Data Model: `UnifiedTextBox`

Every piece of text is stored as a `UnifiedTextBox` instance inside the global `utbState.boxes` array. There are no separate state objects per box type.

```js
{
  id: string,           // stable, e.g. "utb-42"
  type: 'embedded' | 'redaction' | 'harfbuzz',
  page: number,
  text: string,
  lineId: string|null,  // groups spans on the same horizontal text line

  // Spatial — document pixel space (816×1056 base)
  x, y, w, h: float,

  // Typography
  fontFamily: string,
  sizePt: float,        // font size in POINTS — the single canonical unit
                        // (converted to px once, at SVG render time)
  bold, italic, underline, strikethrough: bool,
  letterSpacing: float,
  color: string|null,   // null = per-type default color

  // Word Spacing
  kerning: bool,
  defaultSpaceWidth: bool,    // true = use native font spacing
  spaceWidth: float|null,     // manual override (used when defaultSpaceWidth is false)
  nativeSpaceWidth: float|null, // cached HarfBuzz natural space advance

  // Per-character positioning (from PDF extraction or HarfBuzz)
  baseCharPositions: [{c, x, w}]|null,

  // Micro-typography overrides (index → delta px)
  charAdvances: {},

  // Redaction-only
  widths: {},           // candidate word → pixel width map
  labelText: string,
  tolerance: float,
  manualLabel: bool,
  uppercase: bool,
}
```

### Global state

```js
utbState = {
  boxes: [],           // UnifiedTextBox[]
  selectedId: null,
  microTypoId: null,
  microTypoCharIdx: null,
  editingId: null,     // id of box in inline-text-edit mode
  // addBox / getBox / removeBox / updateBox / getPageBoxes / reset
}
```

---

## SVG Layer Architecture

### Coordinate system

Each page gets one `<svg class="text-layer" data-page="N" viewBox="0 0 816 1056">` absolutely positioned over the page image. The `viewBox` is fixed — it never changes. Zoom is applied solely through CSS `width`/`height` on the SVG element itself.

This means **all box coordinates are always in document pixel space** — no zoom division or scale math anywhere in the rendering code.

### DOM structure per page

```
.page-container
  img#pageN                  ← PDF page image
  svg.text-layer[data-page]  ← text overlay (same dimensions, absolute)
    g.utb-group[data-id][data-type]
      rect.utb-bbox          ← bounding box outline (visible when selected)
      text.utb-text          ← the actual SVG text element
      rect.utb-edge-l        ← left resize handle (4px, transparent)
      rect.utb-edge-r        ← right resize handle (4px, transparent)
```

### Type colors

| Type | Text fill | Bbox stroke |
|------|-----------|-------------|
| `embedded` | `rgba(0, 100, 255, 0.82)` — blue | blue |
| `redaction` | `rgba(129, 201, 149, 0.90)` — green | green |
| `harfbuzz` | `rgba(255, 140, 0, 0.80)` — orange | orange |

Fill is applied as `text.style.fill` (inline style) so it takes priority over the CSS stylesheet. A custom `box.color` value overrides the type default.

---

## Rendering Pipeline

### `renderBox(box)`

The core function. Creates or updates the `<g>` group and its children for a single box. Call this whenever any box property changes (position, text, font, `charAdvances`, etc.).

1. Finds or creates `<svg class="text-layer">` for the page.
2. Finds or creates `<g data-id="...">`.
3. Updates the bbox rect (`x`, `y`, `width`, `height`, `stroke`).
4. Updates the `<text>` element (see below).
5. Recreates the two edge handle rects.

### `<text>` attribute layout

```js
text.setAttribute('y', computeBaseline(box));       // box.y + box.h * 0.85
text.setAttribute('font-size',   GEO.docPtToPx(box.sizePt));  // pt → px (only here)
text.setAttribute('font-family', '"Times New Roman"');
text.setAttribute('x', xs.join(' '));               // one value per character
text.textContent = box.text;
```

**Per-character x positions** come from `computeXPositions(box)`:

```js
// When baseCharPositions is available:
cumulativeDelta = 0
xs[i] = box.x + baseCharPositions[i].x + cumulativeDelta
cumulativeDelta += charAdvances[i] || 0

// Fallback (no per-char data):
xs = [box.x]
```

The cumulative delta means nudging character `i` shifts characters `i+1`, `i+2`, … by the same amount — which is the correct typographic behavior (shifting a glyph also shifts everything to its right).

### `renderTextLayer(pageContainer, pageNum)`

Clears all existing `<g>` groups in the SVG layer and re-renders every box on that page. `svg-renderer.js` subscribes this to the core's `page:rendered` PDFHooks event (emitted by `pdf-viewer.js` in `goToPage`), so the core never calls it by name.

### `renderAllTextLayers()`

Calls `renderTextLayer` for every currently-rendered page. Called after span fetching completes and after font normalization.

---

## Selection

```js
selectBoxInSVG(id)    // adds .selected to matching .utb-group(s), removes from others
deselectAllInSVG()    // clears all .selected
```

The `.selected` class on `.utb-group` makes `.utb-bbox` visible (CSS `visibility: visible`) and changes stroke style. Edge handles are always present but only styled to show a resize cursor on hover.

---

## Embedded Text Ingestion

Text spans are fetched from the backend by `etv-fetch.js (embedded_text_viewer)`, which
subscribes to the core's `document:loaded` and `page:rendered` PDFHooks events (it no
longer monkey-patches `window.loadDocument`). Fetching is **two-tier** so document size
never dictates memory:

1. A background loop (`utbFetchSpans`) walks the whole document in fixed page-range
   chunks — `GET /embedded-text-viewer/api/extract-spans?hash=<state.docHash>&start&count&lean=1`.
   Lean spans (`page, text, x, y, w, h, sizePt, font` — no per-character data) go into a
   per-page cache of JSON strings, exposed read-only to other plugins as
   `window.etvSpanCache` (base64_tool and the OCR layer comparison scan it).
2. When a page is **rendered**, its FULL spans (with `chars`) are fetched
   (`count=1`) and hydrated into `UnifiedTextBox`es. Boxes therefore exist only for
   pages the user has visited.

Within each batch:

1. **Font size normalization**: works directly on the canonical `span.sizePt` (points). The median `sizePt` of the first non-empty batch becomes `documentBasePt`; any span within ±1pt of it is snapped to that value, otherwise it rounds to the nearest whole point — every later batch reuses the same base, so all batches agree. (The normalized value must be written back to `span.sizePt` — `spanToUnified` reads `sizePt`, so normalizing the old px `fontSize` field would be silently ignored.)
2. Same normalization is applied retroactively to existing redaction boxes (once per document).
3. On hydration, each span is converted via `spanToUnified(span)` and added with `utbState.addBox(...)` (the `hydrated` page set prevents double-adds on page revisits).
4. `renderAllTextLayers()` is called.
5. `utbConnectRedactionsToLines()` links redaction boxes to their overlapping text lines.

---

## Line Grouping (`lineId`)

The `lineId` field groups all boxes that belong to the same horizontal line of text. It drives two behaviors:

- **Grouped vertical drag** (`drag-resize.js`): dragging any box vertically moves all boxes sharing its `lineId` and `page` by the same `dy`. Linked redaction boxes also follow.
- **Redaction snapping** (`utbConnectRedactionsToLines`): when a redaction's bounding box overlaps an embedded span by ≥30% of the redaction's height, the redaction inherits that span's `lineId`, `y`, and `h`.

---

## Interaction Modes

The text layer supports three mutually exclusive interaction modes on a selected span:

| Mode | Trigger | `utbState` field | Available for |
|------|---------|-----------------|---------------|
| **Selection** (default) | Single-click a span | `selectedId` | All types |
| **Inline Text Edit** | Double-click a span | `editingId` | `embedded`, `harfbuzz` only |
| **Micro-Typography Nudge** | Nudge button in toolbar | `microTypoId` | Spans with `baseCharPositions` |

Entering one mode automatically exits the other. Escape exits whichever mode is active.

---

## Inline Text Editing — `inline-edit.js`

Double-clicking an `embedded` or `harfbuzz` span enters inline text edit mode. `redaction` spans are excluded by an explicit type guard — their label is machine-written by whichever plugin owns the box, so it is not typed by hand.

> **If no plugin owns that type,** a `redaction` box has nothing writing its label and cannot be hand-edited either. That combination is inert rather than harmful — the box still draws, drags, and resizes — but it means the Add Box tool is only fully useful with an analysis plugin installed. See [Optional Plugins](../plugins/).

1. `enterInlineEdit(box)`:
   - Guards: only `embedded` / `harfbuzz` types. Exits micro-typo if active.
   - Sets `utbState.editingId = box.id`.
   - Adds `.editing` class to the `<g>` group (dashed blue glow on bbox).
   - Hides the SVG `<text>` element.
   - Inserts a `<foreignObject>` sized to the bounding box, containing an `<input type="text">` pre-filled with `box.text`.
   - The input is styled WYSIWYG: matching `fontFamily`, `fontSize`, `color`, `fontWeight`, `fontStyle`.
   - Auto-focuses and selects all text.

2. **Committing** (`commitInlineEdit()`):
   - Reads the input value → `box.text = value`.
   - Removes the `<foreignObject>`, unhides the `<text>`.
   - Re-renders via `renderBox(box)`.
   - Clears `utbState.editingId`.

3. **Cancelling** (`cancelInlineEdit()`):
   - Same cleanup but discards changes (original text preserved).

4. **Event bindings**:
   - `Enter` → commit.
   - `Escape` → cancel.
   - `blur` (click-away) → commit.
   - `mousedown` / `click` on the `<foreignObject>` are stopped from bubbling to prevent drag-resize from intercepting.

---

## Micro-Typography Mode — `micro-typo.js`

Clicking the **Nudge** button (`#fabric-nudge-mode`) in the toolbar enters micro-typography mode for the selected box (requires `baseCharPositions`).

1. `enterMicroTypo(box)`:
   - Guards: box must have `baseCharPositions`, and `editingId` must be null.
   - Adds `.micro-typo` class to the `<g>` group.
   - Creates one invisible `<rect class="utb-char-hit" data-char-idx="N">` per character, sized to that character's advance width.
2. Clicking a hit rect opens a nudge popover with a slider (−20 to +20 px, step 0.1).
3. `applyNudge(box, charIdx, delta)`:
   - Writes `box.charAdvances[charIdx] = delta`.
   - Recomputes x positions via `computeXPositions(box)`.
   - Updates the SVG `<text>` element with a single `setAttribute('x', ...)` call — no DOM reflow.
   - Repositions all hit rects to match.
4. **Escape** closes the popover (first press) or exits micro-typo mode (second press).
5. Clicking the Nudge button again also exits the mode.

The nudge popover is an absolutely-positioned `<div class="utb-nudge-popover">` placed relative to the `.page-container` element.
