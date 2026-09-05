# Redaction Refiner — `redaction_refiner`

Redraws detected redaction bars to the true extent of the hidden name, using the
words that surround each bar on its line. Client-side only, no UI: it runs
automatically whenever redactions are (re)connected to their text lines.

## What it does

For every `redaction` box it builds the **words on its row** from the
embedded/OCR spans sharing the line and takes the nearest word **left** and
**right** of the bar. Words are built from per-character positions when the span
carries them, so a text-layer span that still runs *under* the bar (a rectangle
drawn over live text) contributes only its visible words — anything lying mostly
under the bar is the redacted text itself and is never a neighbour. Nor is a
**remnant sliver**: a lone capital letter touching the bar (OCR reading the
exposed `S` of `SARAH` that the bar failed to cover) belongs to the hidden name,
so the bar grows over it and the next word out is the neighbour. Remnants are
announced on the `redaction:refined` event (below) — they are the hidden name's
own first/last letters, which a matcher can use as a filter.

### Which text layer

When OCR has read the row, its words are used **in preference to** the embedded
ones: OCR reads the glyphs actually *visible* on the page after redaction,
whereas the embedded text layer can carry glyphs the redaction removed from
view — or drop the glyph touching the bar. The auto OCR of a long document can
take minutes, so until it lands the refiner works from the **embedded** spans on
the box's line (the same lookup `embedded_text_viewer` snaps to), and the
fragment rule below recovers what that layer dropped. When the OCR pass finishes,
`redactions:connected` fires again and every bar is re-derived from the OCR
words. Because both derivations describe the same page they land on the same
edge; the verdict is recorded on `box.refineInfo` (`source: 'embedded' | 'ocr'`).

### The three rules

Look at the word facing the bar on each side (its tail on the left, its head on
the right):

- **Punctuation** (any Unicode `\p{P}`: `. , ; : ! ? ' " ) ( - – — /` …) abuts a
  word with no space, so the box edge is redrawn **flush** to where that
  neighbour ends/begins.
- **A whole word** means a real inter-word space sits in the gap, so the edge is
  redrawn **one space-width in** from where the neighbour begins. A token is a
  whole word when it is in the shipped English list (`words.txt`, possessives and
  hyphen compounds included), **or** a name from the candidate pool
  (`state.namesData` / custom names, read through a guarded global), **or**
  capitalised (`Wexner` — a proper noun the list cannot know).
- **A word fragment** — not a word, but a dictionary word *completes* it. This is
  the `including ███ nd GHISLAINE MAXWELL` case: the redaction tool dropped the
  `a` of `and` from the text layer, leaving `nd`. Most-frequent completion first
  (`and` before `end`, `find`, `second` …), the missing letters are measured in
  the neighbour's own font, and the geometry must agree with where they would
  sit — right between the fragment and the name:
  - **under the bar** — the gap between bar and fragment is ~0 (the detector
    swallowed the letters) and the bar is wide enough to hold them plus a
    space, or
  - **visible but unread** — the gap is ~the missing letters' width (the
    letters are on the page; only the text layer lost them).

  If a completion fits, the edge is redrawn one space **plus the missing
  letters** in from the fragment. If none fits (`FORD` a full space away from
  the bar is a word, not `afFORD`), the token is treated as a whole word. If the
  fragment reading would collapse the bar, it falls back to the word reading.

Spaces are sized from the **neighbour word's own font and size** via the shared
HarfBuzz `/widths` path (`getNaturalSpaceWidth`, else a `0.25em` estimate), and
stretched to the row's measured spacing when the line is justified (measured
spaces clearly *above* natural are trusted; a short one under the bar is
ignored). The missing letters of a fragment go through the same `/widths`
endpoint; without it the fragment rule is skipped.

Because both edges are rebuilt from the neighbours rather than nudged from the
painted ink, the result can be **narrower or wider** than the original bar — the
bar is redrawn and `calculateAllWidths` (when present) re-scores it.

### What it leaves alone

- Bars with no neighbouring words on their line.
- The box the user is currently selecting/editing.
- A bar whose neighbours have not changed since it was last refined (the
  re-run after every page hydration is a cheap signature compare).
- A bar the user **moved or resized** after refinement — unless better evidence
  arrives (the OCR layer replacing the embedded one), in which case it is
  re-derived.

## The word list

`static/redaction_refiner/words.txt` — one lowercase word per line, **most
frequent first**. It is the intersection of the
[google-10000-english](https://github.com/first20hours/google-10000-english) 20k
n-gram list (the *order*) with the lowercase entries of a
[SCOWL](https://wordlist.aspell.net) size-60 list (the *validity*; capitalised
and uppercase entries are proper nouns and abbreviations and are excluded so
web junk like `nd` cannot pass). About 15k words, 130 KB, fetched once per
session. `python redaction_refiner/words_build.py` rebuilds it; the licence
notice is `words.LICENSE.txt` next to it.

## How it attaches

| Plugin | Docs | What it does | Routes |
|---|---|---|---|
| `redaction_refiner` | [redaction-refiner/](.) | Redraws redaction bars to the hidden-name extent via surrounding words, punctuation and a word list | *(none — fully client-side)* |

- **Trigger** — subscribes to the generic **`redactions:connected`** PDFHooks
  event, emitted by `embedded_text_viewer`'s `utbConnectRedactionsToLines` after
  it snaps redactions to lines. That single emission covers both the span-load
  path (per hydrated page) and the post-OCR path (`ocr_tool` calls the same
  connect function when its run finishes).
- **Emits `redaction:refined`** after judging a bar:
  `{ boxId, source, changed, remnants: [{ text, side }] }`. Generic — it names
  no consumer; `redaction_matching` listens and turns the remnants into that
  box's starts-with / ends-with filter unless the user already typed one.
- **Guarded globals** — `renderBox` (text_tool), `calculateAllWidths`
  (redaction_matching), `getNaturalSpaceWidth` (text_tool), `GEO` (text_tool),
  `state.namesData` / `state.customCandidates` (redaction_matching). Each call
  site guards, so the refiner degrades cleanly when a provider is absent — with
  no surrounding words it simply does nothing.
- **Manual re-run / inspection** — `window.refineAllRedactions()`,
  `window.refineRedaction(box, { force: true })`, and the pure helpers on
  `window.RedactionRefiner` (`classifyToken`, `completions`, `resolveEdge` …).
  After a run, `box.refineInfo` says what each side was judged to be
  (`punct` / `word` / `fragment`, the token, the completion and its placement),
  the `x`/`w` it produced, and `exact` — true when both edges came from the
  reader's OCR pens, so the width is exact to mupdf's ¼-px lattice. A matcher
  reads `exact` to match names to a quarter pixel instead of a pixel tolerance
  (`redaction_matching` does).

## Tests

`python manage.py test redaction_refiner` covers the registration, the word
list's shape, and — through Node, skipped when `node` is absent — the geometry
(`tests_js/refiner.test.mjs`): the viewer's globals are stubbed, the shaper is
a Times-Roman metrics table (Times New Roman is metric-compatible), and the
fixture rows are real embedded spans of a scanned court filing whose bars were
measured from the raster. Both fixture bars refine to `SARAH KELLEN`'s width
from the embedded layer alone, and again — to the same edge — once OCR words
that read `and` in full are added.

## Candidate verdicts from the page pixels

Width cannot split names that tie to the font unit, and a half-exposed glyph is
not a letter (`A` / `Æ`). So the names that fit the bar by width are *tested*,
never read: `ocr_tool/hypothesis-view.js` defines the seam
`window.ocrTestHypothesis(box, name)`, which draws the name where this refiner
put the bar — the neighbour word's glyph set, baseline, y-phase and ¼-px pens,
the row's own space — composites the bar over it as the redactor did (tol0
LAWS §8, bar last) and lets the page bytes outside the bar's black body judge it
(tol0 `engine/hypothesis.js`, certified there). `redaction_matching` calls it
after every width recompute and shows the verdict on each chip:

- `✓` **consistent** — every judged pixel matches, no page ink in the name's
  window is left unexplained, on at least 12 pixels of evidence;
- `✗` **contradicted** — with the counts in the chip's title;
- `–` **no evidence** — the bar left nothing to compare (a full-height body
  with dark edges, the common case), or the set lacks a glyph.

Two consistent names are a tie, and the tie is the answer. Inputs come from
`neighboursFor(box)` (the neighbour OCR segments and their pens),
`box.refineInfo` (the row space) and the pixel view's page info; the seam
returns `null` — with the reason in `OCRHypothesisView.reasons` — when the
row has no OCR segments, no set is loaded for the face, the raster is not 1:1,
or no detected box overlaps the bar. Design, measurements and limits:
[pixel-evidence-plan.md](pixel-evidence-plan.md); the corpus report:
tol0 `tools/verify-redactions.mjs`.

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
