from django.contrib import admin
from django.urls import path, include
from django.apps import apps
from pdf_core.registry import PDFToolRegistry

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', include('pdf_core.urls')),
]

# 1. UI tools — routes declared on PDFTool subclasses via the registry
for _name, _tool in PDFToolRegistry.get_tools().items():
    if getattr(_tool, 'url_module', None):
        urlpatterns.append(path(_tool.url_prefix, include(_tool.url_module)))

# 2. Backend-only apps — fallback to AppConfig (e.g. extracted_text)
_registered_modules = {
    t.url_module for t in PDFToolRegistry.get_tools().values()
    if getattr(t, 'url_module', None)
}
for _app in apps.get_app_configs():
    if hasattr(_app, 'url_module') and _app.url_module not in _registered_modules:
        urlpatterns.append(path(_app.url_prefix, include(_app.url_module)))
