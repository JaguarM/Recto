from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from .logic.artifact_visualizer import generate_all_masks

import os
from pathlib import Path

_DEFAULT_PDF = Path(__file__).resolve().parent.parent / 'assets' / 'pdfs' / 'times' / 'efta00018586.pdf'

@csrf_exempt
def generate_masks(request):
    if request.method == 'GET' and request.GET.get('default') == 'true':
        if not _DEFAULT_PDF.exists():
            return JsonResponse({"detail": "Default PDF not found"}, status=404)
        file_bytes = _DEFAULT_PDF.read_bytes()
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
