from django.apps import AppConfig


class RedactionRefinerConfig(AppConfig):
    name = 'redaction_refiner'

    def ready(self):
        import redaction_refiner.tool  # noqa: F401 — registers RedactionRefinerTool
