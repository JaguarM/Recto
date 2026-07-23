"""Demo backend — a thin shell over Recto's pdf_core.logic modules.

Three jobs only: list/open the sample PDFs, accept an upload, and serve one
page raster at a time. All document handling (hash store, metadata, cropped
rasters) is imported from pdf_core so the demo stays byte-identical with the
main app's pixel space.
"""
from pathlib import Path

from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt

from pdf_core.logic import document_store
from pdf_core.logic.document_loader import load_pdf_meta, page_image_bytes

DEMO_DIR = Path(__file__).resolve().parent.parent
# Sample PDFs: drop files into demo/samples/; the repo's bundled startup PDF
# (assets/pdfs/) is included too so the demo works out of the box.
SAMPLE_DIRS = (DEMO_DIR / 'samples', DEMO_DIR.parent / 'assets' / 'pdfs')
# Output of `manage.py prerender_samples` — in production nginx serves this
# directory directly and requests never reach Django.
PRERENDERED_DIR = DEMO_DIR / 'prerendered'

_IMMUTABLE = 'public, max-age=31536000, immutable'


def _samples():
    seen = {}
    for d in SAMPLE_DIRS:
        if not d.is_dir():
            continue
        for p in sorted(d.glob('*.pdf')):
            seen.setdefault(p.name, p)
    return seen


def index(request):
    return render(request, 'viewer/index.html', {
        'samples': [{'name': n, 'size_kb': p.stat().st_size // 1024}
                    for n, p in _samples().items()],
    })


def _open_stored(doc_hash, filename):
    path = document_store.find(doc_hash)
    result = load_pdf_meta(path)
    if 'error' in result:
        return JsonResponse({'detail': result['error']}, status=500)
    result['sha256'] = doc_hash
    result['filename'] = filename
    return JsonResponse(result)


def open_sample(request, name):
    path = _samples().get(name)
    if path is None:
        return JsonResponse({'detail': 'Unknown sample'}, status=404)
    doc_hash = document_store.save_bytes(path.read_bytes(), path.name)
    return _open_stored(doc_hash, path.name)


@csrf_exempt
def open_document(request):
    if request.method != 'POST':
        return JsonResponse({'detail': 'Method not allowed'}, status=405)
    file = request.FILES.get('file')
    if file is None or not file.name:
        return JsonResponse({'detail': 'No file uploaded'}, status=400)
    if not file.name.lower().endswith('.pdf'):
        return JsonResponse({'detail': 'The demo opens PDF files only'}, status=400)
    doc_hash = document_store.save_upload(file, ext='.pdf')
    return _open_stored(doc_hash, file.name)


def prerendered(request, name, filename):
    """Dev-only stand-in for nginx's `location /prerendered/` — same files,
    same immutable caching. URL converters exclude '/', so only a literal
    '..' segment could escape; reject it."""
    if '..' in (name, filename):
        return JsonResponse({'detail': 'Not found'}, status=404)
    path = PRERENDERED_DIR / name / filename
    if not path.is_file():
        return JsonResponse({'detail': 'Not found'}, status=404)
    is_json = filename.endswith('.json')
    resp = HttpResponse(path.read_bytes(),
                        content_type='application/json' if is_json else 'image/png')
    # meta.json must revalidate (a sample file can be replaced under the same
    # name); images are safe to cache forever because the frontend versions
    # their URLs with ?v=<sha> taken from meta.json.
    resp['Cache-Control'] = 'no-cache' if is_json else _IMMUTABLE
    return resp


def page_image(request, doc_hash, page_num):
    path = document_store.find(doc_hash)
    if path is None:
        return JsonResponse({'detail': 'Unknown document'}, status=404)
    found = page_image_bytes(path, page_num)
    if found is None:
        return JsonResponse({'detail': 'No such page'}, status=404)
    data, mime = found
    resp = HttpResponse(data, content_type=mime)
    resp['Cache-Control'] = _IMMUTABLE
    return resp
