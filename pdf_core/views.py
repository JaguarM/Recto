from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt

from .logic import document_store
from .logic.default_document import find_default_document
from .logic.document_loader import load_image_meta, load_pdf_meta, page_image_bytes
from .registry import PDFToolRegistry

IMAGE_MIME_TYPES = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
    'image/tiff': '.tif', 'image/bmp': '.bmp', 'image/webp': '.webp',
}
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'}

# Page rasters are immutable by construction — the URL embeds the document's
# content hash — so the browser may cache them forever. This is what keeps the
# lazy viewer cheap: revisiting a page never re-asks the server.
_IMMUTABLE = 'public, max-age=31536000, immutable'


def index(request):
    tools = PDFToolRegistry.get_tools()
    return render(request, 'pdf_core/index.html', {
        'tools': tools,
    })


def _meta(path):
    """Dispatch to the image or PDF describer based on the stored extension."""
    is_image = path.suffix.lower() in IMAGE_EXTENSIONS
    return load_image_meta(path) if is_image else load_pdf_meta(path)


@csrf_exempt
def open_document(request):
    """Open an uploaded PDF or image: store it once, describe it.

    The response is metadata only (page count, geometry, typography, sha256).
    Page rasters are fetched lazily per page from ``/page-image/<hash>/<n>``,
    so a two-thousand-page document costs the same to open as a two-page one.
    Plugins that want to analyse the document subscribe to the
    ``document:loaded`` hook and call their own endpoints with the hash.
    """
    if request.method != 'POST':
        return JsonResponse({"detail": "Method not allowed"}, status=405)

    if 'file' not in request.FILES:
        return JsonResponse({"detail": "No file uploaded"}, status=400)

    file = request.FILES['file']
    if not file.name:
        return JsonResponse({"detail": "No file selected"}, status=400)

    try:
        # Type dispatch happens via the stored extension; trust the filename
        # first and fall back to the declared MIME type (files named without
        # an extension still land on the right loader).
        ext = document_store.safe_ext(file.name)
        if ext == '.pdf' and not (file.name or '').lower().endswith('.pdf'):
            ext = IMAGE_MIME_TYPES.get((file.content_type or '').lower(), '.pdf')
        doc_hash = document_store.save_upload(file, ext=ext)
        path = document_store.find(doc_hash)
        result = _meta(path)
        if "error" in result:
            return JsonResponse({"detail": result["error"]}, status=500)
        # Document identity: plugins key their own per-document requests off this.
        result["sha256"] = doc_hash
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
        doc_hash = document_store.save_bytes(document.read_bytes(), document.name)
        path = document_store.find(doc_hash)
        result = _meta(path)
        if "error" in result:
            return JsonResponse({"detail": result["error"]}, status=500)

        result["default_filename"] = document.name
        result["sha256"] = doc_hash
        return JsonResponse(result)
    except Exception as e:
        return JsonResponse({"detail": str(e)}, status=500)


def page_image(request, doc_hash, page_num):
    """One page's raster (``?thumb=1`` for the 180px sidebar variant)."""
    if request.method != 'GET':
        return JsonResponse({"detail": "Method not allowed"}, status=405)

    path = document_store.find(doc_hash)
    if path is None:
        return JsonResponse({"detail": "Unknown document"}, status=404)

    found = page_image_bytes(path, page_num, thumb=request.GET.get('thumb') == '1')
    if found is None:
        return JsonResponse({"detail": "No such page"}, status=404)

    data, mime = found
    resp = HttpResponse(data, content_type=mime)
    resp['Cache-Control'] = _IMMUTABLE
    return resp
