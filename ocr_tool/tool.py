from pdf_core.base import PDFTool
from pdf_core.registry import register_tool


@register_tool
class OcrTool(PDFTool):
    """Auto OCR — the char_training blind reader running on the page rasters.

    Client-side only: no routes, no models. The engine/ and glyphs/ static
    files are synced VERBATIM from the char_training repo by its
    ``tools/sync-recto.mjs`` (``npm run sync:recto`` there) — never edit them
    here; edit in char_training, re-certify against its corpus gate, re-sync.
    Only ocr-tool.js (the Recto adapter) is owned by this app.
    """
    name = 'ocr_tool'
    styles = [{'path': 'ocr_tool/styles.css'}]
    toolbar_button = 'ocr_tool/toolbar_button.html'
    options_bar = 'ocr_tool/options_bar.html'
    scripts_after_app = [
        # engine files (synced — versions rewritten by sync-recto.mjs)
        {'path': 'ocr_tool/engine/core.js', 'version': 'v=4c9df04f'},
        {'path': 'ocr_tool/engine/ocr.js', 'version': 'v=3e8cb783'},
        {'path': 'ocr_tool/engine/blindocr.js', 'version': 'v=a7fb1133'},
        # the adapter (Recto-owned)
        {'path': 'ocr_tool/ocr-tool.js', 'version': 'v=3'},
    ]
