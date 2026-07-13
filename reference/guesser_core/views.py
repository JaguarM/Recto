import os
from pathlib import Path
from django.shortcuts import render
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from .logic.ProcessRedactions import process_pdf, process_image

IMAGE_MIME_TYPES = {'image/png', 'image/jpeg', 'image/jpg', 'image/tiff', 'image/bmp', 'image/webp'}
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'}

from guesser_core.registry import PDFToolRegistry


def index(request):
    tools = PDFToolRegistry.get_tools()
    context = {
        'tools': tools,
        'show_text_options_bar': any(t.shows_text_options_bar for t in tools.values()),
        'has_any_sidebar': any(t.sidebar for t in tools.values()),
    }
    return render(request, 'guesser_core/index.html', context)

@csrf_exempt
def analyze_pdf(request):
    if request.method != 'POST':
        return JsonResponse({"detail": "Method not allowed"}, status=405)

    if 'file' not in request.FILES:
        return JsonResponse({"detail": "No file uploaded"}, status=400)

    file = request.FILES['file']
    if file.name == '':
        return JsonResponse({"detail": "No file selected"}, status=400)

    try:
        file_bytes = file.read()
        mime = (file.content_type or '').lower()
        ext = os.path.splitext(file.name or '')[1].lower()
        is_image = mime in IMAGE_MIME_TYPES or ext in IMAGE_EXTENSIONS

        result = process_image(file_bytes, mime or 'image/png') if is_image else process_pdf(file_bytes)

        if "error" in result:
            return JsonResponse({"detail": result["error"]}, status=500)

        return JsonResponse(result)
    except Exception as e:
        return JsonResponse({"detail": str(e)}, status=500)




# ---------------------------------------------------------------------------
# Default PDF auto-load
# ---------------------------------------------------------------------------
_DEFAULT_PDF = Path(__file__).resolve().parent.parent / 'assets' / 'pdfs' / 'times' / 'efta00018586.pdf'

def analyze_default(request):
    """GET endpoint that processes the bundled default PDF and returns the
    same JSON payload as /analyze-pdf, allowing the frontend to auto-load
    on startup without a user file-upload."""
    if request.method != 'GET':
        return JsonResponse({"detail": "Method not allowed"}, status=405)

    if not _DEFAULT_PDF.exists():
        return JsonResponse({"detail": f"Default PDF not found: {_DEFAULT_PDF}"}, status=404)

    try:
        file_bytes = _DEFAULT_PDF.read_bytes()
        result = process_pdf(file_bytes)

        if "error" in result:
            return JsonResponse({"detail": result["error"]}, status=500)

        result["default_filename"] = _DEFAULT_PDF.name
        return JsonResponse(result)
    except Exception as e:
        return JsonResponse({"detail": str(e)}, status=500)
