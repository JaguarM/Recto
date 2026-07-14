from pdf_core.base import PDFTool
from pdf_core.registry import register_tool


@register_tool
class RedactionMatchingTool(PDFTool):
    """Candidate-name matching against detected redaction bars.

    Pairs with `redaction_lab`, which does the detection and owns the Match
    ribbon (tolerance / kerning / uppercase). This plugin owns the candidate
    pool, the name-format settings, and the matches table in the right sidebar.
    """
    name = 'redaction_matching'
    styles = [{'path': 'redaction_matching/styles.css'}]
    toolbar_button = 'redaction_matching/toolbar_button.html'
    sidebar = 'redaction_matching/sidebar_tools.html'
    has_sidebar_toggle = True
    # v=10 — names data moved into this plugin (static/redaction_matching/names.json);
    # api.js no longer fetches it from the project-wide assets/ folder.
    # Bump on every change: the version is the cache key, and a stale v= will
    # serve the browser's old copy.
    scripts_before_viewer = [{'path': 'redaction_matching/api.js', 'version': 'v=10'}]
