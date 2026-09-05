from pdf_core.base import PDFTool
from pdf_core.registry import register_tool


@register_tool
class RedactionMatchingTool(PDFTool):
    """Candidate-name matching against detected redaction bars.

    Detection is done by whichever detector is installed (e.g. ocr_tool, which
    emits redaction boxes as it reads). This plugin owns the full candidates
    right panel — the host <aside id="tools-sidebar">, its toolbar toggle
    button, styling and wiring — plus the candidate pool, name-format settings,
    and matches table. The Tolerance/Kerning/Uppercase controls live in
    text_tool's formatting ribbon (shared element IDs). Delete this folder and
    no trace of a candidates sidebar remains in the core.
    """
    name = 'redaction_matching'
    styles = [{'path': 'redaction_matching/styles.css'}]
    toolbar_button = 'redaction_matching/toolbar_button.html'
    sidebar = 'redaction_matching/sidebar_tools.html'
    # v=17 — widths in the page's own face: when a reader has read the bar's
    # row, the optional window.ocrMeasureWidths seam lays the candidates out
    # in the reader's glyph set (the producer's build of the face) and those
    # widths replace the HarfBuzz ones; aliases expand by default. v=16: two
    # bars, one name (pair readings), fit ranges with the detector's padding,
    # near misses the page vouches for. Bump on every change: the version is
    # the cache key, and a stale v= will serve the browser's old copy.
    scripts_before_viewer = [{'path': 'redaction_matching/api.js', 'version': 'v=17'}]
