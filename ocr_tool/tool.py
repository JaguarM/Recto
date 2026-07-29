from pdf_core.base import PDFTool
from pdf_core.registry import register_tool


@register_tool
class OcrTool(PDFTool):
    """Auto OCR — the char_training blind reader running on the page rasters.

    The engine runs client-side; the only backend piece is the precomputed-OCR
    cache for the startup document (views.py — written in dev, read-only in
    production). The engine/ and glyphs/ static files are synced VERBATIM from
    the char_training repo by its ``tools/sync-recto.mjs`` (``npm run
    sync:recto`` there) — never edit them here; edit in char_training,
    re-certify against its corpus gate, re-sync. Only ocr-tool.js (the Recto
    adapter) and the cache endpoint are owned by this app.
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
        {'path': 'ocr_tool/engine/ocr-engine.js', 'version': 'v=4481e85f'},
        {'path': 'ocr_tool/engine/blindocr.js', 'version': 'v=e17c99c1'},
        # the adapter (Recto-owned)
        {'path': 'ocr_tool/ocr-tool.js', 'version': 'v=6'},
    ]
