from django.apps import AppConfig


class WebglMaskConfig(AppConfig):
    name = 'webgl_mask'

    def ready(self):
        import webgl_mask.tool  # noqa: F401 — registers WebglMaskTool
