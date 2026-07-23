from django.http import HttpResponse, JsonResponse
from django.views.decorators.csrf import csrf_exempt

from pdf_core.logic import document_store
from pdf_core.logic.default_document import find_default_document

from .logic.artifact_visualizer import generate_all_masks, generate_mask_for_page


def page_mask(request, doc_hash, page_num):
    """Redaction mask for one page of a stored document, generated on demand.

    200 with a grayscale PNG when the page has detected redactions, 204 when
    it has none (a normal answer, not an error). The document was stored by
    ``/open-document`` — nothing is re-uploaded to analyse it.
    """
    if request.method != 'GET':
        return JsonResponse({"detail": "Method not allowed"}, status=405)

    path = document_store.find(doc_hash)
    if path is None:
        return JsonResponse({"detail": "Unknown document"}, status=404)
    if path.suffix.lower() != '.pdf':
        return HttpResponse(status=204)   # raw images carry no embedded rasters to analyse

    mask_png = generate_mask_for_page(str(path), page_num)
    if mask_png is None:
        resp = HttpResponse(status=204)
    else:
        resp = HttpResponse(mask_png, content_type='image/png')
    # Deterministic per content hash + page — cacheable forever.
    resp['Cache-Control'] = 'public, max-age=31536000, immutable'
    return resp


@csrf_exempt
def generate_masks(request):
    """Whole-document mask pass — legacy fallback (the viewer fetches per page)."""
    if request.method == 'GET' and request.GET.get('default') == 'true':
        default_pdf = find_default_document()
        if default_pdf is None:
            return JsonResponse({"detail": "Default PDF not found"}, status=404)
        file_bytes = default_pdf.read_bytes()
        masks = generate_all_masks(file_bytes)
        return JsonResponse({"mask_images": masks})

    if request.method != 'POST':
        return JsonResponse({"detail": "Method not allowed"}, status=405)

    if 'file' not in request.FILES:
        return JsonResponse({"detail": "No file uploaded"}, status=400)

    file = request.FILES['file']
    if file.name == '':
        return JsonResponse({"detail": "No file selected"}, status=400)

    try:
        file_bytes = file.read()
        masks = generate_all_masks(file_bytes)
        return JsonResponse({"mask_images": masks})
    except Exception as e:
        return JsonResponse({"detail": str(e)}, status=500)
