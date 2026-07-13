from django.apps import AppConfig


class OcrToolConfig(AppConfig):
    name = 'ocr_tool'

    def ready(self):
        import ocr_tool.tool  # noqa: F401 — registers OcrTool
