from django.apps import AppConfig


class RedactionMatchingConfig(AppConfig):
    name = 'redaction_matching'

    def ready(self):
        import redaction_matching.tool  # noqa: F401 — registers RedactionMatchingTool
