from pdf_core.base import PDFTool
from pdf_core.registry import register_tool


@register_tool
class OcrTool(PDFTool):
    """Auto OCR — the tol0 blind reader running on the page rasters, plus the
    MuPDF pixel view (text boxes drawn from the reader's glyph bitmaps).

    The engine runs client-side; the only backend piece is the precomputed-OCR
    cache for the startup document (views.py — written in dev, read-only in
    production). The engine/ and glyphs/ static files are synced VERBATIM from
    the tol0 repo by its ``tools/sync-recto.mjs`` (``npm run sync:recto``
    there) — never edit them here; edit in tol0, re-certify (``npm test``,
    ``npm run certify:ftclone``, ``npm run certify:render``), re-sync. Only
    ocr-tool.js (the OCR adapter), ocr-worker.js (its Worker: the reader off
    the main thread), ocr-result.js (the slim result shape both threads and
    the cache share), pixel-view.js (the pixel view adapter) and the cache
    endpoint are owned by this app.
    """
    name = 'ocr_tool'
    url_module = 'ocr_tool.urls'
    styles = [{'path': 'ocr_tool/styles.css'}]
    toolbar_button = 'ocr_tool/toolbar_button.html'
    options_bar = 'ocr_tool/options_bar.html'
    scripts_after_app = [
        # engine files (synced — versions rewritten by sync-recto.mjs)
        {'path': 'ocr_tool/engine/core.js', 'version': 'v=ab4d2193'},
        {'path': 'ocr_tool/engine/ocr.js', 'version': 'v=b95cb058'},
        {'path': 'ocr_tool/engine/ocr-engine.js', 'version': 'v=61264268'},
        {'path': 'ocr_tool/engine/blindocr.js', 'version': 'v=a663fe73'},
        {'path': 'ocr_tool/engine/render.js', 'version': 'v=d7ecfa23'},
        {'path': 'ocr_tool/engine/set-fonts.js', 'version': 'v=29e7faf6'},
        {'path': 'ocr_tool/engine/hypothesis.js', 'version': 'v=466417e3'},
        # the adapters (Recto-owned). ocr-result.js is shared with the reader's
        # Worker (ocr-worker.js, fetched by url from ocr-tool.js — not a page script)
        {'path': 'ocr_tool/ocr-result.js', 'version': 'v=2'},
        {'path': 'ocr_tool/ocr-tool.js', 'version': 'v=9'},
        {'path': 'ocr_tool/pixel-view.js', 'version': 'v=5'},
        # the hypothesis seam: window.ocrTestHypothesis for redaction_matching
        {'path': 'ocr_tool/hypothesis-view.js', 'version': 'v=6'},
    ]
