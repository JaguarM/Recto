# Redaction Refiner — `redaction_refiner`

Redraws detected redaction bars to the true extent of the hidden word, using the
text that surrounds each bar on its line. Client-side only, no UI: it runs
automatically whenever redactions are (re)connected to their text lines.

## What it does

For every `redaction` box it finds the embedded/OCR word immediately **left** and
**right** of the box on the same text line, then rebuilds each edge.

When OCR has read the row, its words are used **in preference to** the embedded
ones: OCR reads the glyphs actually *visible* on the page after redaction,
whereas the embedded text layer can still carry glyphs the redaction removed from
view. A following word like `and` whose leading `a` was dropped from the text
layer survives there as `nd` at the `n`'s position — about one glyph to the right
of where the word visibly begins — and measuring the box edge against that
clipped neighbour would push the edge past the real word start and widen the bar
(by the width of the hidden `a`). OCR's `and` sits at the true visible start, so
it gives the correct extent. With no OCR on the row it falls back to the embedded
spans on the box's line (the same lookup `embedded_text_viewer` snaps to). Then:

- Look at the character on the neighbour word that **faces the box** — its last
  character on the left, its first character on the right.
- **Punctuation** (any Unicode `\p{P}`: `. , ; : ! ? ' " ) ( - – — /` …) abuts a
  word with no space, so the box edge is redrawn **flush** to where that
  neighbour word ends/begins.
- **Anything else** means a real inter-word space sits in the gap, so the edge is
  redrawn **one space-width in** from where the neighbour word begins, back
  toward the redaction. The space is sized from the **neighbour word's own font
  and size** via the shared HarfBuzz `/widths` path (`getNaturalSpaceWidth`),
  falling back to a `0.25em` estimate if that global is absent.

Because both edges are rebuilt from the neighbours rather than nudged from the
painted ink, the result can be **narrower or wider** than the original bar — the
bar is redrawn. This mirrors the reference `SurroundingWordWidth` pipeline
(expected edge = neighbour near-edge ∓ one space). After redrawing, candidate
widths are recomputed once (`calculateAllWidths`, when present) so any matching
suite re-scores the new bar width.

Boxes with no neighbouring words on their line, and the box the user is currently
selecting/editing, are left untouched. The refinement is idempotent — it derives
edges from the (stable) neighbour words, so re-running (e.g. after an OCR pass)
converges rather than drifting.

## How it attaches

| Plugin | Docs | What it does | Routes |
|---|---|---|---|
| `redaction_refiner` | [redaction-refiner/](.) | Redraws redaction bars to the hidden-word extent via surrounding words + punctuation | *(none — fully client-side)* |

- **Trigger** — subscribes to the generic **`redactions:connected`** PDFHooks
  event, emitted by `embedded_text_viewer`'s `utbConnectRedactionsToLines` after
  it snaps redactions to lines. That single emission covers both the span-load
  path and the post-OCR path (`ocr_tool` calls the same connect function).
- **Guarded globals** — `renderBox` (text_tool), `calculateAllWidths`
  (redaction_matching), `getNaturalSpaceWidth` (text_tool), `GEO` (text_tool).
  Each call site guards with `typeof … === 'function'`, so the refiner degrades
  cleanly when a provider is absent — with no surrounding words it simply does
  nothing.
- **Manual re-run** — exposes `window.refineAllRedactions()` and
  `window.refineRedaction(box)` for tooling/console use.

## Dependencies

```
redaction_refiner ──'redactions:connected' hook──> embedded_text_viewer
                  ──runtime globals─────────────> text_tool ──> pdf_core
```

- **Needs a source of `redaction` boxes** (e.g. `ocr_tool` or the Add-Box tool)
  and **surrounding text** on their lines (`embedded_text_viewer` spans or
  `ocr_tool` lines). With neither, there is nothing to measure against and it
  no-ops.
- Removing it: delete the `redaction_refiner/` folder and this docs folder, and
  drop its row from the table in [`../README.md`](../README.md). The
  `redactions:connected` emission in `embedded_text_viewer` is generic (it names
  no plugin) and simply emits into the void once no one subscribes.
