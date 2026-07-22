"""Precomputed-OCR cache for the startup document.

One JSON file per document in ``ocr_tool/cache/``, named by the SHA-256 of the
document bytes (the core returns that hash as ``sha256`` from
``/open-document`` / ``/open-default``). The adapter checks the cache before
running the engine on the auto-loaded startup document; a hit skips the whole
engine — including the ~10 MB glyph-set download — so the page is fully
readable immediately.

Writes are dev-only (``DEBUG``): the cache ships with the repo. Open the app
locally once after swapping the startup PDF, let the automatic OCR finish, and
commit the new ``ocr_tool/cache/<hash>.json``. In production the endpoint is
read-only — a public write path would let anyone overwrite the boxes every
visitor sees.
"""
import json
import re
from pathlib import Path

from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.views.decorators.csrf import csrf_exempt

CACHE_DIR = Path(__file__).resolve().parent / 'cache'
_HASH_RE = re.compile(r'^[0-9a-f]{64}$')
_MAX_BYTES = 32 * 1024 * 1024


@csrf_exempt
def ocr_cache(request, doc_hash):
    if not _HASH_RE.match(doc_hash or ''):
        return JsonResponse({'detail': 'Invalid document hash'}, status=400)
    path = CACHE_DIR / f'{doc_hash}.json'

    if request.method == 'GET':
        # A miss is a normal, expected answer — 200 (not 404) so the browser
        # console stays clean (char_training's smoke gate fails on console
        # errors). no-store: a cached miss must not mask a later-deployed file.
        if not path.exists():
            resp = JsonResponse({'cached': False})
        else:
            resp = HttpResponse(path.read_bytes(), content_type='application/json')
        resp['Cache-Control'] = 'no-store'
        return resp

    if request.method == 'POST':
        if not settings.DEBUG:
            return JsonResponse({'detail': 'OCR cache is read-only in production — '
                                 'generate it in local dev and commit ocr_tool/cache/'}, status=403)
        body = request.body
        if len(body) > _MAX_BYTES:
            return JsonResponse({'detail': 'Payload too large'}, status=413)
        try:
            data = json.loads(body)
        except ValueError:
            return JsonResponse({'detail': 'Invalid JSON'}, status=400)
        if not isinstance(data, dict) or not isinstance(data.get('pages'), list) \
                or not isinstance(data.get('version'), int):
            return JsonResponse({'detail': 'Unexpected payload shape'}, status=400)
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        return JsonResponse({'stored': True, 'file': path.name})

    return JsonResponse({'detail': 'Method not allowed'}, status=405)
