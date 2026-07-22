from django.apps import AppConfig


class Base64ToolConfig(AppConfig):
    name = 'base64_tool'

    def ready(self):
        import base64_tool.tool  # noqa: F401 — registers Base64Tool
