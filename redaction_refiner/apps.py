from django.apps import AppConfig


class RedactionRefinerConfig(AppConfig):
    name = 'redaction_refiner'

    def ready(self):
        # Import for side effects: registers the PDFTool and the refiners.
        from . import tool         # noqa: F401  registers the PDFTool
        from . import etv_refiner  # noqa: F401  registers EtvRefiner
