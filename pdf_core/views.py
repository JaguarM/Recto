import os
from pathlib import Path

from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt

from .logic.document_loader import load_image, load_pdf
from .registry import PDFToolRegistry

IMAGE_MIME_TYPES = {'image/png', 'image/jpeg', 'image/jpg', 'image/tiff', 'image/bmp', 'image/webp'}
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'}

# Bundled sample document, auto-loaded on startup so the app opens with
# something on screen. Plugins that need the same bytes import this path.
DEFAULT_DOCUMENT = Path(__file__).resolve().parent.parent / 'assets' / 'pdfs' / 'times' / 'efta00018586.pdf'


def index(request):
    tools = PDFToolRegistry.get_tools()
    return render(request, 'pdf_core/index.html', {
        'tools': tools,
        'has_any_sidebar': any(t.sidebar for t in tools.values()),
    })


def _load(file_bytes, name, content_type):
    """Dispatch to the image or PDF loader based on the file's type."""
    mime = (content_type or '').lower()
    ext = os.path.splitext(name or '')[1].lower()
    is_image = mime in IMAGE_MIME_TYPES or ext in IMAGE_EXTENSIONS
    return load_image(file_bytes, mime or 'image/png') if is_image else load_pdf(file_bytes)


@csrf_exempt
def open_document(request):
    """Open an uploaded PDF or image and return everything needed to render it.

    This is the core's whole job on ingestion: rasterize the pages, read the
    embedded text, report the typography. It runs no analysis. Plugins that want
    to analyse the document subscribe to the ``document:loaded`` hook and call
    their own endpoints.
    """
    if request.method != 'POST':
        return JsonResponse({"detail": "Method not allowed"}, status=405)

    if 'file' not in request.FILES:
        return JsonResponse({"detail": "No file uploaded"}, status=400)

    file = request.FILES['file']
    if not file.name:
        return JsonResponse({"detail": "No file selected"}, status=400)

    try:
        result = _load(file.read(), file.name, file.content_type)
        if "error" in result:
            return JsonResponse({"detail": result["error"]}, status=500)
        return JsonResponse(result)
    except Exception as e:
        return JsonResponse({"detail": str(e)}, status=500)


def open_default(request):
    """Open the bundled sample document, so the app has something on screen at
    startup without waiting for an upload. Same payload as ``/open-document``."""
    if request.method != 'GET':
        return JsonResponse({"detail": "Method not allowed"}, status=405)

    if not DEFAULT_DOCUMENT.exists():
        return JsonResponse({"detail": f"Sample document not found: {DEFAULT_DOCUMENT}"}, status=404)

    try:
        result = load_pdf(DEFAULT_DOCUMENT.read_bytes())
        if "error" in result:
            return JsonResponse({"detail": result["error"]}, status=500)

        result["default_filename"] = DEFAULT_DOCUMENT.name
        return JsonResponse(result)
    except Exception as e:
        return JsonResponse({"detail": str(e)}, status=500)
