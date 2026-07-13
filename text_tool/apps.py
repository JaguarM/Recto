from django.apps import AppConfig


class TextToolConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'text_tool'

    def ready(self):
        import text_tool.tool  # noqa: F401 — registers TextTool
