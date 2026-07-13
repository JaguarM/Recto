# Unified Toolbar — `toolbar.js` + `text-tool.js`

`toolbar.js` manages the formatting toolbar and is the single code path for reading and writing typography properties on any `UnifiedTextBox`. There is no branching on `box.type` — `embedded`, `redaction`, and `harfbuzz` boxes are all handled identically.

`text-tool.js` handles manual box creation.

---

## Toolbar Controls

| Control ID | Property | Notes |
|------------|----------|-------|
| `#fabric-font-family` | `box.fontFamily` | CSS family name (e.g. `"Times New Roman"`) |
| `#fabric-font-size` | `box.sizePt` | Displayed, entered, and stored in **points** — no conversion |
| `#fabric-bold` | `box.bold` | Toggle button (`.active` class = on) |
| `#fabric-italic` | `box.italic` | Toggle button |
| `#fabric-underline` | `box.underline` | Toggle button |
| `#fabric-strikethrough` | `box.strikethrough` | Toggle button |
| `#fabric-color` | `box.color` | Hex color; `null` = per-type default |
| `#fabric-nudge-mode` | — | Toggle button; enters/exits micro-typography nudge mode on the selected span. Disabled when the span has no `baseCharPositions`. |
| `#fabric-letter-spacing` | `box.letterSpacing` | em units |
| `#fabric-default-sw` | `box.defaultSpaceWidth` | Checkbox; when checked, uses the font's native space width. Uncheck for manual slider control. |
| `#fabric-space-width` | `box.spaceWidth` | Slider; active only when `#fabric-default-sw` is unchecked |

---

## Font Size Units

Font size has a single canonical unit — **points** — stored on `box.sizePt`.
The toolbar reads and writes that value directly, with no DPI conversion:

```
toolbar input  =  box.sizePt        (points, both directions)
```

Points are converted to image pixels exactly once, at the SVG render boundary
(`GEO.docPtToPx(box.sizePt)` in `svg-renderer.js`). There is no separate px
`fontSize` field. The conversion helpers live on `window.GEO`, defined by the core's
`pdf_core/logic/geometry.py` coordinate contract.

---

## `syncToolbarToBox(box)`

Reads from the `UnifiedTextBox` and pushes values into the toolbar UI. Called whenever a box is selected (from `drag-resize.js`) or when the selection changes.

```js
fsInput.value = Math.round(box.sizePt * 100) / 100;  // points, shown directly
```

Also sets font family, bold/italic/underline/strikethrough active states, letter spacing, color, Default Space Width checkbox, space-width slider, and nudge button state (active if micro-typo mode is active for this box, disabled if box lacks `baseCharPositions`).

---

## `persistFromToolbar(box)`

Reads the current toolbar state and writes it directly to the box, then calls `renderBox(box)`.

```js
const inputSize = parseFloat(el('fabric-font-size').value);   // points
box.sizePt = !isNaN(inputSize) ? inputSize : box.sizePt;
```

If `box.defaultSpaceWidth` is unchecked and the box has text, the manual `box.spaceWidth` from the slider is used.

If `box.type === 'redaction'` and font or size changed, `calculateWidthsForRedaction(box.id)` is called to recalculate the candidate-word width map. `text_tool` does not define that function — the call is `typeof`-guarded, so it resolves when a plugin supplies it and no-ops when none does. See [Optional Plugins](../plugins/).

---

## Natural Space Width

When the "Default" checkbox is unchecked, the slider is initialized to the font's natural space advance by calling the HarfBuzz backend:

```js
POST /widths
{
  strings: [' '],
  font: 'times.ttf',        // derived from box.fontFamily
  size: box.sizePt,         // points
  scale: GEO.docScale(),    // = (pageWidth / 612) × 100
  kerning: box.kerning,
}
→ { results: [{ width: float }] }    // natural space advance
```

The result is written to `box.spaceWidth` and `box.nativeSpaceWidth`. When the checkbox is re-checked, `box.spaceWidth` is set to `null` (native font spacing).

---

## Nudge Button

The **Nudge** button (`#fabric-nudge-mode`) in the Style group enters micro-typography mode on the selected span:

- **Click** when a span is selected and has `baseCharPositions` → calls `enterMicroTypo(box)`.
- **Click** again (or press Escape) → calls `exitMicroTypo()`.
- The button is **disabled** when no span is selected or the span lacks per-character positions.

This replaced the old double-click gesture, which is now used for inline text editing (see `inline-edit.js`).

---

## Event Wiring

| Event | Element | Action |
|-------|---------|--------|
| `change` | `#fabric-font-family` | `persistFromToolbar` |
| `input` | `#fabric-font-size` | Live `renderBox` only (no candidate recalc) |
| `change` | `#fabric-font-size` | Full `persistFromToolbar` (with candidate recalc) |
| `click` | bold/italic/underline/strikethrough buttons | Toggle `.active`, `persistFromToolbar` |
| `change` | `#fabric-letter-spacing` | `persistFromToolbar` |
| `input` | `#fabric-color` | `box.color = value`, `renderBox` |
| `change` | `#fabric-default-sw` | Toggle native vs manual space width; fetch natural width via HarfBuzz when unchecking |
| `input` | `#fabric-space-width` | Live `box.spaceWidth = value`, `renderBox`, update display label |
| `click` | `#fabric-nudge-mode` | Toggle micro-typography mode on selected span |

---

## Lifecycle: `text-tool.js`

> Span fetching and the `document:loaded` lifecycle subscription live in `embedded_text_viewer/etv-fetch.js`. `text-tool.js` handles only manual box creation.

### Placing new boxes

- `window.handleManualAddBox(pageNum, x, y)`: delegates to `createNewRedaction()` if a plugin supplies it, otherwise creates a `type='redaction'` box directly. Calls `window._utbFindNearestLine?.()` — defined by `etv-fetch.js` (optional: gracefully absent if the ETV plugin is not installed). Both are optional seams; the tool works either way.
