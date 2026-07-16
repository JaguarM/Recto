from pdf_core.base import PDFTool
from pdf_core.registry import register_tool


@register_tool
class EmbeddedTextViewerTool(PDFTool):
    name = 'embedded_text_viewer'
    url_prefix = 'embedded-text-viewer/'
    url_module = 'embedded_text_viewer.urls'
    styles = [{'path': 'embedded_text_viewer/styles.css'}]
    toolbar_button = 'embedded_text_viewer/toolbar_button.html'
    options_bar = 'embedded_text_viewer/options_bar.html'
    scripts_after_app = [
        {'path': 'embedded_text_viewer/etv-fetch.js', 'version': 'v=4'},
    ]
