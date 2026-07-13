import json
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from pdf_core.logic import geometry as geo
from .logic.width_calculator import get_text_widths, get_available_fonts, get_justified_space_width


@csrf_exempt
def calculate_widths(request):
    if request.method != 'POST':
        return JsonResponse({"detail": "Method not allowed"}, status=405)
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"detail": "Invalid JSON"}, status=400)

    texts = data.get('strings', [])
    try:
        font_name = str(data.get('font') or 'times.ttf')
        font_size = float(data.get('size') or 12)
        scale = float(data.get('scale') or geo.DEFAULT_SCALE)
        force_uppercase = bool(data.get('force_uppercase', False))
        kerning = bool(data.get('kerning', True))
        space_width = data.get('space_width')
        if space_width is not None:
            space_width = float(space_width)

        # justify mode: compute the space width needed to fill block_w
        mode = data.get('mode', '')
        if mode == 'justified':
            block_w = float(data.get('block_w', 0))
            text = texts[0] if texts else ''
            jsw = get_justified_space_width(text, block_w, font_name, font_size,
                                            force_uppercase, scale / 100.0, kerning)
            return JsonResponse({"space_width": jsw})

        widths = get_text_widths(texts, font_name, font_size, force_uppercase,
                                  scale / 100.0, kerning, space_width=space_width)
        return JsonResponse({"results": widths})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JsonResponse({"detail": str(e)}, status=500)


def list_fonts(_request):
    return JsonResponse(get_available_fonts(), safe=False)
