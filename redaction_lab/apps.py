from django.apps import AppConfig


class RedactionLabConfig(AppConfig):
    name = 'redaction_lab'

    def ready(self):
        import redaction_lab.tool  # noqa: F401 — registers RedactionLabTool
