from pdf_core.base import PDFTool
from pdf_core.registry import register_tool


@register_tool
class RedactionRefinerTool(PDFTool):
    """Redraw detected redaction bars to the true hidden-word extent.

    For each redaction box it looks at the embedded/OCR word adjacent on the
    left and right of the box on its text line. Punctuation is flush only when
    the mark binds toward the bar (a comma binds left: flush against a bar on
    its left, a space before one on its right); a whole word (in the
    shipped English list, the candidate-name pool, or capitalised) has a real
    space before it, so the edge is redrawn one space-width in; a word FRAGMENT
    ("nd" left over from "and") has its missing letters next to the bar, so the
    edge is redrawn one space plus those letters in. Spaces and letters are
    sized from the neighbour word's own font/size (the same HarfBuzz `/widths`
    path the space-width logic already uses).

    No UI. It runs automatically on the 'redactions:connected' lifecycle event
    (emitted by embedded_text_viewer's utbConnectRedactionsToLines, on both the
    span-load and OCR paths). Attaches only through the PDFHooks bus and guarded
    globals — delete this folder and nothing in the core or the baseline plugins
    references it.
    """
    name = 'redaction_refiner'
    scripts_after_app = [
        {'path': 'redaction_refiner/redaction-refiner.js', 'version': 'v=7'},
    ]
