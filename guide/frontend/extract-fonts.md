# extract_fonts — Font Detection Module

**File:** `text_tool/logic/extract_fonts.py`

Detects the dominant font used in a PDF and maps it to one of the `.ttf` files
available in `assets/fonts/`. The result is returned to the frontend as
`suggested_font` and `suggested_size` so the toolbar and width calculator are
pre-configured on every PDF load.

---

## How it fits into the pipeline

```
POST /open-document
  └── load_pdf()                # pdf_core.logic.document_loader
        └── extracts text_spans  # PyMuPDF span data, one entry per text run
  └── detect_dominant_font()     # text_tool.logic.extract_fonts   ← this module
        └── returns font_file, font_size, pdf_font_name
  └── JsonResponse
        ├── suggested_font       # e.g. "times.ttf"
        └── suggested_size       # e.g. 12.0

Browser (pdf-viewer.js)
  └── sets els.font.value  = suggested_font
  └── sets els.size.value  = suggested_size
  └── seeds every redaction's settings.font / settings.size
```

---

## Public API

### `detect_dominant_font(text_spans, available_fonts)`

Analyses pre-extracted text spans and returns the font that accounts for the
most body-text characters in the document.

**Parameters**

| Name | Type | Description |
|---|---|---|
| `text_spans` | `list[dict]` | Span list produced by `pdf_core.logic.document_loader.load_pdf`. Each entry: `{"page": int, "text": str, "font": {"size": float, "flags": int, "matched_font": str}}` |
| `available_fonts` | `list[str]` | `.ttf` filenames present in `assets/fonts/` (from `width_calculator.get_available_fonts()`). Only fonts in this list can be returned. |

**Returns** — `dict`

| Key | Type | Description |
|---|---|---|
| `font_file` | `str \| None` | Filename to load, e.g. `"times.ttf"`. `None` if the dominant font has no match in `available_fonts`. |
| `font_size` | `float` | Most common size (in points) for that font across all spans. |
| `pdf_font_name` | `str` | Raw internal PDF font name, e.g. `"TimesNewRomanPSMT"`. |

**Example**

```python
from text_tool.logic.extract_fonts import detect_dominant_font
from text_tool.logic.width_calculator import get_available_fonts

result = detect_dominant_font(spans, get_available_fonts())
# {"font_file": "times.ttf", "font_size": 12.0, "pdf_font_name": "TimesNewRomanPSMT"}
```

---

## Detection algorithm

1. **Aggregate character counts** — iterate every span; accumulate the number
   of characters per `(pdf_font_name, size)` pair.
2. **Filter noise** — discard any font whose total character count is below
   `MIN_CHARS` (currently `35`). This eliminates page headers, footnotes,
   watermarks, and one-off decorative glyphs that are not representative of
   body text.
3. **Pick dominant font** — the font with the highest total character count
   after filtering.
4. **Pick dominant size** — for that font, the size bucket with the most
   characters.
5. **Map to `.ttf`** — run the PDF internal name through `FONT_MAP` (see
   below); return the first matching `.ttf` that exists in `available_fonts`.

---

## Font mapping table (`FONT_MAP`)

Evaluated top-to-bottom; first keyword match wins.

| Keywords in PDF font name | Mapped `.ttf` file |
|---|---|
| `times`, `roman` | `times.ttf` |
| `courier` | `courier_new.ttf` |
| `arial`, `helvetica` | `arial.ttf` |
| `calibri` | `calibri.ttf` |
| `verdana` | `verdana.ttf` |
| `segoe` | `segoe_ui.ttf` |

If no keyword matches, or the matched `.ttf` is not present in `available_fonts`,
`font_file` is returned as `None` and the frontend falls back to whatever is
currently selected in the font dropdown.

---

## Constants

| Name | Default | Purpose |
|---|---|---|
| `MIN_CHARS` | `35` | Minimum character count for a font to be considered significant. Raise to be more conservative; lower to detect fonts in short documents. |

---

## Standalone script

The module doubles as a CLI tool for auditing font metadata across a local
directory tree. Run directly with Python:

```bash
python text_tool/logic/extract_fonts.py
```

The `base_directory` and `target_directories` at the bottom of the file control
which folders are scanned. For each PDF found it prints every recognised font
along with its character count, type, and encoding, and tags the highest-use
font as `[PRIMARY FONT]`.

This is useful for verifying that the `FONT_MAP` keywords cover the fonts
present in a new corpus before uploading documents to the tool.

---

## Adding a new font

1. Drop the `.ttf` file into `assets/fonts/`.
2. Add a row to `FONT_MAP` in `extract_fonts.py`:
   ```python
   (["myfont", "alternate-name"], "myfont.ttf"),
   ```
3. Keywords are matched against the **lowercase** PDF-internal font name, so
   use lowercase in the keyword list.
4. Place the new row before any existing row whose keywords could
   accidentally match the same font name.
