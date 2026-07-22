import hashlib
import os

from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt

from .logic.default_document import find_default_document
from .logic.document_loader import load_image, load_pdf
from .registry import PDFToolRegistry

IMAGE_MIME_TYPES = {'image/png', 'image/jpeg', 'image/jpg', 'image/tiff', 'image/bmp', 'image/webp'}
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'}


def index(request):
    tools = PDFToolRegistry.get_tools()
    return render(request, 'pdf_core/index.html', {
        'tools': tools,
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
        file_bytes = file.read()
        result = _load(file_bytes, file.name, file.content_type)
        if "error" in result:
            return JsonResponse({"detail": result["error"]}, status=500)
        # Document identity: plugins key their own per-document caches off this.
        result["sha256"] = hashlib.sha256(file_bytes).hexdigest()
        return JsonResponse(result)
    except Exception as e:
        return JsonResponse({"detail": str(e)}, status=500)


def open_default(request):
    """Open the bundled startup document (the PDF in ``assets/pdfs/``), so the
    app has something on screen at startup without waiting for an upload. Same
    payload as ``/open-document``."""
    if request.method != 'GET':
        return JsonResponse({"detail": "Method not allowed"}, status=405)

    document = find_default_document()
    if document is None:
        return JsonResponse({"detail": "No startup PDF found in assets/pdfs/"}, status=404)

    try:
        file_bytes = document.read_bytes()
        result = load_pdf(file_bytes)
        if "error" in result:
            return JsonResponse({"detail": result["error"]}, status=500)

        result["default_filename"] = document.name
        result["sha256"] = hashlib.sha256(file_bytes).hexdigest()
        return JsonResponse(result)
    except Exception as e:
        return JsonResponse({"detail": str(e)}, status=500)
