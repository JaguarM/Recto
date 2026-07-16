from pdf_core.base import PDFTool
from pdf_core.registry import register_tool


@register_tool
class RedactionRefinerTool(PDFTool):
    """Redraw detected redaction bars to the true hidden-word extent.

    For each redaction box it looks at the embedded/OCR character adjacent on the
    left and right of the box on its text line. Punctuation abuts a word with no
    space, so that edge is redrawn flush to the neighbour; otherwise the edge is
    redrawn one space-width in from where the neighbour word begins — the space
    sized from that neighbour word's own font/size (the same HarfBuzz `/widths`
    path the space-width logic already uses).

    No UI. It runs automatically on the 'redactions:connected' lifecycle event
    (emitted by embedded_text_viewer's utbConnectRedactionsToLines, on both the
    span-load and OCR paths). Attaches only through the PDFHooks bus and guarded
    globals — delete this folder and nothing in the core or the baseline plugins
    references it.
    """
    name = 'redaction_refiner'
    scripts_after_app = [
        {'path': 'redaction_refiner/redaction-refiner.js', 'version': 'v=1'},
    ]
