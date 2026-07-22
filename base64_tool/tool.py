from pdf_core.base import PDFTool
from pdf_core.registry import register_tool


@register_tool
class Base64Tool(PDFTool):
    """Base64 attachment decoder — finds base64 blocks in the document's text
    layer (whichever unified-text-box layer is visible: OCR or embedded),
    decodes them client-side, sniffs the file type, and offers the result as
    a download or an in-browser view. Fully client-side; no routes.
    """
    name = 'base64_tool'
    styles = [{'path': 'base64_tool/styles.css'}]
    toolbar_button = 'base64_tool/toolbar_button.html'
    options_bar = 'base64_tool/options_bar.html'
    scripts_after_app = [
        {'path': 'base64_tool/base64-tool.js', 'version': 'v=2'},
    ]
