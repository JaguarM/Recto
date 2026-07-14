import os

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from pdf_core.views import IMAGE_EXTENSIONS, IMAGE_MIME_TYPES

from .logic.detect import detect_image, detect_pdf


@csrf_exempt
def analyze(request):
    """Detect redaction bars in an uploaded document.

    The core has already opened and rendered this file; the frontend re-posts it
    here from the ``document:loaded`` hook. Returns ``{"redactions": [...]}`` in
    the same image-pixel space the viewer renders, so the boxes can be dropped
    straight onto the page.
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
        mime = (file.content_type or '').lower()
        ext = os.path.splitext(file.name or '')[1].lower()
        is_image = mime in IMAGE_MIME_TYPES or ext in IMAGE_EXTENSIONS

        result = detect_image(file_bytes) if is_image else detect_pdf(file_bytes)

        if "error" in result:
            return JsonResponse({"detail": result["error"]}, status=500)

        return JsonResponse(result)
    except Exception as e:
        return JsonResponse({"detail": str(e)}, status=500)


@csrf_exempt
def analyze_default(request):
    """Detect redactions in the bundled sample document.

    Mirrors the core's ``/open-default`` so the auto-loaded document gets its
    boxes too, without the frontend needing a File object it never had.
    """
    if request.method != 'GET':
        return JsonResponse({"detail": "Method not allowed"}, status=405)

    from pdf_core.views import DEFAULT_DOCUMENT

    if not DEFAULT_DOCUMENT.exists():
        return JsonResponse({"detail": "No sample document bundled"}, status=404)

    try:
        result = detect_pdf(DEFAULT_DOCUMENT.read_bytes())
        if "error" in result:
            return JsonResponse({"detail": result["error"]}, status=500)
        return JsonResponse(result)
    except Exception as e:
        return JsonResponse({"detail": str(e)}, status=500)
