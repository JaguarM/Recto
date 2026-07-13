from django.apps import AppConfig


class EmbeddedTextViewerConfig(AppConfig):
    name = 'embedded_text_viewer'

    def ready(self):
        import embedded_text_viewer.tool  # noqa: F401 — registers EmbeddedTextViewerTool
