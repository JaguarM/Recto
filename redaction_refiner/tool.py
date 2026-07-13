from guesser_core.base import PDFTool
from guesser_core.registry import register_tool

@register_tool
class RedactionRefinerTool(PDFTool):
    name = 'redaction_refiner'
    # Refinement runs server-side in EtvRefiner (see etv_refiner.py); this tool
    # contributes no frontend script.
