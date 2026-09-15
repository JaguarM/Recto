import json
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from pdf_core.logic import geometry as geo
from .logic import fonts
from .logic.width_calculator import get_text_widths, get_justified_space_width
from .logic.font_metrics import font_metrics


@csrf_exempt
def calculate_widths(request):
    """HarfBuzz widths. The face is named the catalogue way — `family`,
    `bold`, `italic` — or, for older callers, as a file: `font: 'times.ttf'`."""
    if request.method != 'POST':
        return JsonResponse({"detail": "Method not allowed"}, status=405)
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"detail": "Invalid JSON"}, status=400)

    texts = data.get('strings', [])
    try:
        family = data.get('family')
        font_name = str(data.get('font') or '') or None
        if family:
            font_path = fonts.resolve(family, bool(data.get('bold')), bool(data.get('italic')))
        else:
            font_path = fonts.resolve_file(font_name) or fonts.resolve(fonts.default_family())
        font_size = float(data.get('size') or 12)
        scale = float(data.get('scale') or geo.DEFAULT_SCALE)
        force_uppercase = bool(data.get('force_uppercase', False))
        kerning = bool(data.get('kerning', True))
        ligatures = bool(data.get('ligatures', True))
        space_width = data.get('space_width')
        if space_width is not None:
            space_width = float(space_width)

        # justify mode: compute the space width needed to fill block_w
        mode = data.get('mode', '')
        if mode == 'justified':
            block_w = float(data.get('block_w', 0))
            text = texts[0] if texts else ''
            jsw = get_justified_space_width(text, block_w, font_path, font_size,
                                            force_uppercase, scale / 100.0, kerning)
            return JsonResponse({"space_width": jsw})

        widths = get_text_widths(texts, font_path, font_size, force_uppercase,
                                  scale / 100.0, kerning, space_width=space_width,
                                  ligatures=ligatures)
        return JsonResponse({"results": widths})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JsonResponse({"detail": str(e)}, status=500)


def list_fonts(_request):
    """The catalogue: families, their style files and which are installed."""
    return JsonResponse({'families': fonts.families(), 'default': fonts.default_family(),
                         'static': '/static/fonts/'})


def font_metrics_view(request):
    """A catalogue face's own advances and kern pairs at a pixel size —
    ``?family=&bold=&italic=&size_px=`` — through HarfBuzz. The OCR plugin's
    pixel view judges a page's pens against this table to learn whether the
    producer kerned, and lays typed text with it when it did."""
    family = request.GET.get('family') or fonts.default_family()
    bold = request.GET.get('bold', '0') in ('1', 'true', 'True')
    italic = request.GET.get('italic', '0') in ('1', 'true', 'True')
    try:
        size_px = float(request.GET.get('size_px') or 16)
    except ValueError:
        return JsonResponse({"detail": "size_px must be a number"}, status=400)
    if not (0 < size_px <= 512):
        return JsonResponse({"detail": "size_px out of range"}, status=400)
    font_path = fonts.resolve(family, bold, italic)
    if not font_path:
        return JsonResponse({"detail": "No font installed for that family"}, status=404)
    try:
        data = font_metrics(font_path, round(size_px, 6))
    except RuntimeError as e:
        return JsonResponse({"detail": str(e)}, status=503)
    return JsonResponse({"family": family, "bold": bold, "italic": italic, **data})
