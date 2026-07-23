from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from pdf_core.logic import document_store
from pdf_core.logic.default_document import find_default_document

# A chunk two hundred pages long would take multiple seconds to extract; the
# frontend paces itself with `count`, this just caps a single request's work.
_MAX_COUNT = 200


@csrf_exempt
def extract_spans(request):
    """
    Extracts embedded text spans from a PDF and returns their coordinates in
    the 816×1056 viewer pixel space.

    GET with ``?hash=<sha256>``: reads the stored document (saved by
    ``/open-document``) — with optional ``start``/``count`` to extract only a
    page range. This is how the viewer fetches text: in chunks, without ever
    re-uploading the file. ``lean=1`` strips each span to the fields a text
    *scan* needs (page, text, geometry, size, font) — about a tenth of the
    full payload, which is what makes background-fetching a whole huge
    document's text affordable; the viewer requests full spans (with
    per-character positions) only for the page it is actually showing.

    POST with a file upload, or a bare GET (bundled default PDF), remain as
    whole-document fallbacks.
    """
    doc_hash = request.GET.get('hash')
    if request.method == 'GET' and doc_hash:
        path = document_store.find(doc_hash)
        if path is None:
            return JsonResponse({'detail': 'Unknown document'}, status=404)
        if path.suffix.lower() != '.pdf':
            return JsonResponse({'spans': [], 'num_pages': 1})   # images have no embedded text
        try:
            start = max(1, int(request.GET.get('start', 1)))
            count = min(_MAX_COUNT, max(1, int(request.GET.get('count', _MAX_COUNT))))
        except ValueError:
            return JsonResponse({'detail': 'start/count must be integers'}, status=400)
        try:
            from extracted_text.logic.extract import extract_spans_range
            result = extract_spans_range(str(path), start, count)
            spans = result['spans']
            if request.GET.get('lean') == '1':
                spans = [{'page': s['page'], 'text': s['text'],
                          'x': s['x'], 'y': s['y'], 'w': s['w'], 'h': s['h'],
                          'sizePt': s['sizePt'], 'font': s['font']}
                         for s in spans]
            return JsonResponse({'spans': spans, 'num_pages': result['numPages']})
        except Exception as e:
            return JsonResponse({'detail': str(e)}, status=500)

    if request.method == 'GET':
        default_pdf = find_default_document()
        if default_pdf is None:
            return JsonResponse({'detail': 'Default PDF not found'}, status=404)
        pdf_bytes = default_pdf.read_bytes()
    elif request.method == 'POST':
        if 'file' not in request.FILES:
            return JsonResponse({'detail': 'No file uploaded'}, status=400)
        pdf_bytes = request.FILES['file'].read()
    else:
        return JsonResponse({'detail': 'Method not allowed'}, status=405)

    try:
        from extracted_text.logic.extract import extract_pdf
        result = extract_pdf(pdf_bytes)
        return JsonResponse({'spans': result['spans']})
    except Exception as e:
        return JsonResponse({'detail': str(e)}, status=500)
