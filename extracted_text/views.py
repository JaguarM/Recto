import json
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from .logic.width_calculator import get_text_widths, get_available_fonts


@csrf_exempt
def calculate_widths(request):
    """Deprecated: /widths is now served by text_tool. This view is kept as a fallback."""
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
        scale = float(data.get('scale') or 135)
        force_uppercase = bool(data.get('force_uppercase', False))
        kerning = bool(data.get('kerning', True))
        ligatures = bool(data.get('ligatures', True))
        space_width = data.get('space_width')
        if space_width is not None:
            space_width = float(space_width)

        widths = get_text_widths(texts, font_name, font_size, force_uppercase,
                                  scale / 100.0, kerning, ligatures, space_width=space_width)
        return JsonResponse({"results": widths})
    except Exception as e:
        return JsonResponse({"detail": str(e)}, status=500)


def list_fonts(_request):
    """Deprecated: /fonts-list is now served by text_tool."""
    return JsonResponse(get_available_fonts(), safe=False)
