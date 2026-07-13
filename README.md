# Recto

An extensible PDF editor. Open a PDF or scanned image, edit and add real text with true
font metrics, mask regions, and inspect embedded text — then extend it with drop-in plugins.

## How it works

Recto's core does one thing: it opens a document, renders its pages, and exposes a plugin
API. Everything else is a plugin.

- **`pdf_core`** — the shell. Opens the document, rasterizes pages, reads the embedded
  text and typography, and hosts the viewer. It runs no analysis of its own.
- **`text_tool`** — edit and add text with real font metrics (HarfBuzz-shaped widths).
- **`embedded_text_viewer`** — inspect the text already embedded in the PDF.
- **`webgl_mask`** — GPU-accelerated region masking.
- **`extracted_text`** — backend text extraction and glyph calibration.
- **`redaction_lab`** — finds black redaction bars and turns each into an editable box
  sized to the bar, so you can measure what text would fit it.

Plugins are discovered by scanning for any directory containing an `apps.py`. **Drop a
folder in to add a tool; delete the folder to remove it.** A plugin registers itself with
`@register_tool`, declares the UI slots it fills (toolbar button, ribbon bar, sidebar,
scripts, styles), and subscribes to lifecycle events on the `PDFHooks` bus — so the core
never calls a plugin by name, and removing one leaves nothing dangling.

See [`guide/tool-expansion-guide.md`](guide/tool-expansion-guide.md) to write one.

## Install & run (Windows)

> **Requires:** [Python 3.10+](https://www.python.org/downloads/) installed and on PATH.

Double-click **`run_app.bat`** — it installs dependencies and opens the app in your browser.

## Install & run (Linux / macOS)

```bash
python -m pip install -r requirements.txt
python manage.py runserver 5000
```

Then open <http://localhost:5000>.

## Documentation

Full documentation is in [`guide/`](guide/).

## A note on redaction_lab

`redaction_lab` estimates what *could* fit under a redaction bar by measuring text widths.
It produces **guesses, not facts** — a width match is not evidence of anything, and any
given result may be completely wrong. It is not fit for legal proceedings, journalism, or
any use where an unverified guess could cause harm. Don't use it to circumvent lawful
redactions or violate anyone's privacy. If you don't want it, delete the folder.
