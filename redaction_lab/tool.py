from pdf_core.base import PDFTool
from pdf_core.registry import register_tool


@register_tool
class RedactionLabTool(PDFTool):
    """Redaction analysis, as a plugin.

    Finds black redaction bars in the open document and turns each one into an
    editable text box sized to the bar, so you can try text against it and see
    what fits. Delete this folder and Recto is simply a PDF editor that has
    never heard of redactions.
    """
    name = 'redaction_lab'
    url_prefix = 'redaction/'
    url_module = 'redaction_lab.urls'
    styles = [{'path': 'redaction_lab/styles.css'}]
    ribbon_bar = 'redaction_lab/match_bar.html'
    scripts_after_app = [
        {'path': 'redaction_lab/redaction-lab.js', 'version': 'v=1'},
    ]
