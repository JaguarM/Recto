from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from pdf_core.logic.default_document import find_default_document


@csrf_exempt
def extract_spans(request):
    """
    Extracts every embedded text span from a PDF and returns their coordinates
    in the 816×1056 viewer pixel space.

    POST: receives a PDF file upload in request.FILES['file']
    GET:  processes the bundled default PDF (for auto-load)
    """
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
