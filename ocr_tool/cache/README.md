# Precomputed OCR results

One `<sha256-of-document>.json` per document, written automatically when the
automatic OCR of the **startup document** (the PDF in `assets/pdfs/`) finishes
in local dev, and served read-only by `/ocr/cache/<hash>` everywhere.

Commit these files: with the matching cache present, production visitors get
the OCR text boxes instantly instead of waiting for the in-browser engine.
After swapping the startup PDF, open the app locally once, let the OCR finish,
and commit the new file here (stale files for old documents can be deleted).
