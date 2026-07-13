# API & Candidate Logic — `api.js`

> [!IMPORTANT]
> **The `redaction_matching` plugin is not currently installed.** This document describes its
> design and is retained as a specification for reimplementing it. Nothing in the shipped code
> defines `addName`, `calculateAllWidths`, `renderCandidates`, `selectRedaction`,
> `updateAllMatchesView`, or `calculateWidthsForRedaction`.
>
> `text_tool` still contains `typeof fn === 'function'` guarded call sites for these — they are
> deliberate, inert re-attachment seams. A reinstalled matching plugin defines those globals and
> the call sites light up again. The *detection* half — the `redaction_lab` plugin — has since
> been removed as well, so neither half currently ships.

`api.js` managed the candidate name list, sent width calculation requests to the backend,
rendered the candidates table, and matched candidate widths against redaction box widths.

## Per-box format, global pool

Two things are split:

- **Per box** — the **Name format** controls (Generate / Include / Expand aliases) live on `box.nameSettings`. Each box formats names its own way and produces its own `box.candidates` (format applied to the global pool ∪ custom names). The sidebar panel edits whichever scope is *active*: the selected box, or — when nothing is selected — `state.nameSettings`, the **template** copied onto each new box. The `#name-format-scope` label ("· this box" / "· new boxes") shows which; `syncNameSettingsUI()` pushes the active settings into the checkboxes on select/deselect.
- **Global** — the underlying *people pool*. `state.customCandidates` (added names) and `state.excludedPersons` (deleted people, by `namesData` index) are shared across every box. Adding and deleting operate on this pool, so a name shows up in / disappears from **all** boxes at once.

`generateCandidatesFromData(namesData, settings, { excluded, ownerMap })` skips `excluded` person indices and, when given an `ownerMap`, records which person produced each string so a deleted row can be traced back to a person.

`state.candidates` is not the matching source — it is the template union (template settings ∪ custom, minus deleted) used only by the uppercase heuristic in `embedded-text-viewer.js`. Per-box matching reads `box.candidates` via `getBoxCandidates(box)`.

## Candidate Management

### `addName()` / `processPaste()`
Adds names to `state.customCandidates` (global), then rebuilds every box's `candidates` and recalculates widths.

### `clearAll()`
Prompts confirmation, then clears the custom names **and** the deleted-people set (restoring deletions), and rebuilds every box.

### `removeName(name)`
Global delete. Traces the clicked row — which may be just a first or last name — back to the whole person via the selected box's owner map, adds that person to `state.excludedPersons`, drops the name from the custom list if present, then rebuilds every box. The whole name disappears from every box regardless of each box's format.

## Width Calculation

### `calculateAllWidths()`
Sends one `POST /widths` request per redaction (in parallel via `Promise.all`), using each redaction's individual `settings` (font, size, scale, kerning).

### `calculateWidthsForRedaction(idx)`
Sends a single width calculation request for the candidate list using the settings of redaction `idx`. Stores results in `redaction.widths[candidateName] = measuredWidth`.

## Rendering

### `renderCandidates()`
Renders the paginated candidates table in the sidebar. Shows name, measured width, and a delete button. Supports sorting by name or width.

### `selectRedaction(idx)`
Selects a redaction by index: navigates to its page, updates the settings controls, highlights the redaction overlay and the match table row, then re-renders candidates.

### `updateAllMatchesView(onlyIdx?)`
Re-renders the "All Matches" table. For each redaction, finds candidates whose width is within the tolerance. Updates the overlay label text (unless manually overridden). Shows match count summary.

## Helper

### `getFontFamily(fontName)`
Maps font filenames to CSS font-family strings:
- `times` → `"Times New Roman", serif`
- `arial` → `Arial, sans-serif`
- `calibri` → `Calibri, sans-serif`
- `cour` → `"Courier New", monospace`
