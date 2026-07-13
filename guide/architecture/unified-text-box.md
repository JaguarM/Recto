# Unified Text Box System

All text on a page — extracted PDF text, redaction labels, and HarfBuzz recreations — is stored and rendered through a single data model and a single rendering pipeline. There are no separate state objects for spans, redactions, or HarfBuzz overlays.

See [embedded-text-viewer.md](../frontend/embedded-text-viewer.md) for the full `UnifiedTextBox` field reference and SVG rendering internals.

---

## Box Types

| `type` | Origin | Role |
|---|---|---|
| `embedded` | PDF extractor (`/api/extract-spans`) | Ground-truth text; not user-editable via the text tool |
| `redaction` | User draws a box on the page | Label text managed by the match engine; snaps font/size to nearest `embedded` box |
| `harfbuzz` | Inspector tool | Transient overlay that visualises HarfBuzz-computed layout; used to diagnose spacing errors |

Each type renders with a distinct colour (defined in `svg-renderer.js::UTB_TYPE_COLORS`):
- `embedded` — blue
- `redaction` — green
- `harfbuzz` — orange

---

## Module Reference

All five modules live in `text_tool/static/text_tool/`.

| Module | Responsibility | Key exports |
|---|---|---|
| `unified-text-box.js` | `UnifiedTextBox` class and `utbState` global | `utbState.addBox()`, `getBox()`, `updateBox()`, `getPageBoxes()`, `reset()` |
| `svg-renderer.js` | Renders boxes as SVG `<text>` elements in a per-page layer | `renderBox(box)`, `renderTextLayer(pageContainer, pageNum)`, `renderAllTextLayers()`, `computeXPositions(box)`, `computeBaseline(box)` |
| `toolbar.js` | Unified formatting toolbar — one code path for all box types | `syncToolbarToBox(box)`, `syncToolbarToSelection()` |
| `micro-typo.js` | Per-character nudge mode via hit-rects and a popover slider | `enterMicroTypo(box)`, `exitMicroTypo()` |
| `inline-edit.js` | Double-click WYSIWYG editing for `embedded` and `harfbuzz` boxes | `enterInlineEdit(box)`, `commitInlineEdit()`, `cancelInlineEdit()` |

---

## Rendering Pipeline

```
utbState.boxes
    │
    ▼
renderBox(box)            ← called by renderTextLayer() / renderAllTextLayers()
    │
    ├─ computeBaseline(box)          baseline y in SVG coordinate space
    │
    └─ computeXPositions(box)        absolute x array for SVG <text x="…">
           │
           ├─ box.baseCharPositions  per-char offsets from PDF extraction / HarfBuzz
           ├─ box.charAdvances[i]    accumulated per-char nudge deltas (micro-typo)
           └─ box.spaceWidth         manual word-spacing override (when defaultSpaceWidth=false)
    │
    ▼
SVG <text> element in .text-layer[data-page="N"]
```

The SVG layer uses a fixed `viewBox` matching document pixel space (816 × 1056). Zoom is handled entirely by CSS sizing on the layer element — coordinate values in `box.x/y/w/h` never change.

---

## Interactions

### Toolbar

Clicking any box activates the formatting toolbar. `syncToolbarToBox(box)` pushes the box's properties into the UI; every control writes back directly to the `UnifiedTextBox` instance via `utbState.updateBox()`. There is no branching on `box.type`.

### Space Width

Each box has an independent `defaultSpaceWidth` boolean and `spaceWidth` float.

- `defaultSpaceWidth = true` — the box uses the font's native space advance (`nativeSpaceWidth`, cached from HarfBuzz).
- `defaultSpaceWidth = false` — the slider is active; `spaceWidth` overrides the space width and `computeXPositions` shifts all characters after each space accordingly.

### Inline Text Editing

Double-clicking an `embedded` or `harfbuzz` box calls `enterInlineEdit(box)`, which places a `<foreignObject>` overlay containing a styled `<input>` that matches the box's font, size, weight, style, and colour.

- `Enter` or click-away → `commitInlineEdit()` saves `box.text` and re-renders.
- `Escape` → `cancelInlineEdit()` discards changes.

`redaction` boxes are excluded — their `labelText` is managed by the match engine.

### Micro-Typography (Nudge Mode)

Clicking the Nudge button (↔) in the toolbar calls `enterMicroTypo(box)`. The renderer draws invisible hit-rects over each character. Clicking a character opens a popover slider that writes a delta (in px) to `box.charAdvances[charIndex]`. `computeXPositions` accumulates all prior deltas so nudging character *i* also shifts characters *i+1, i+2, …* — matching the SVG `<text x="…">` array contract.
