from guesser_core.base import PDFTool
from guesser_core.registry import register_tool


@register_tool
class RedactionMatchingTool(PDFTool):
    name = 'redaction_matching'
    styles = [{'path': 'redaction_matching/styles.css'}]
    toolbar_button = 'redaction_matching/toolbar_button.html'
    sidebar = 'redaction_matching/sidebar_tools.html'
    shows_text_options_bar = True
    has_sidebar_toggle = True
    scripts_before_viewer = [{'path': 'redaction_matching/api.js', 'version': 'v=7'}]
