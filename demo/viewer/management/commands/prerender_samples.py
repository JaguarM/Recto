"""Pre-render every sample PDF to static files so production visitors who
click a sample card never touch Python.

For each sample this writes ``demo/prerendered/<name>/``:

- ``meta.json`` — the same payload ``/open-sample`` returns, plus
  ``image_base`` telling the frontend where the page images live
- ``1.png`` … ``<num_pages>.png`` — the per-page rasters, byte-identical to
  what ``/page-image`` would serve (same ``page_image_bytes`` code path, so
  the client-side OCR reads the same pixels either way)

In production nginx serves ``/prerendered/`` straight from disk with
immutable caching; in dev a small Django view does the same. Re-running the
command skips samples whose file hash hasn't changed.
"""
import hashlib
import json

from django.core.management.base import BaseCommand

from pdf_core.logic.document_loader import load_pdf_meta, page_image_bytes
from viewer.views import PRERENDERED_DIR, _samples


class Command(BaseCommand):
    help = 'Pre-render sample PDFs into demo/prerendered/ for static serving'

    def add_arguments(self, parser):
        parser.add_argument('--only', help='Pre-render a single sample by filename')
        parser.add_argument('--force', action='store_true', help='Re-render even if unchanged')

    def handle(self, *args, **opts):
        samples = _samples()
        if opts['only']:
            samples = {k: v for k, v in samples.items() if k == opts['only']}
            if not samples:
                self.stderr.write(f"No sample named {opts['only']}")
                return
        for name, path in samples.items():
            sha = hashlib.sha256(path.read_bytes()).hexdigest()
            outdir = PRERENDERED_DIR / name
            meta_path = outdir / 'meta.json'
            if meta_path.is_file() and not opts['force']:
                try:
                    if json.loads(meta_path.read_text())['sha256'] == sha:
                        self.stdout.write(f'{name}: unchanged, skipping')
                        continue
                except (ValueError, KeyError):
                    pass
            meta = load_pdf_meta(path)
            if 'error' in meta:
                self.stderr.write(f"{name}: {meta['error']}")
                continue
            outdir.mkdir(parents=True, exist_ok=True)
            for n in range(1, meta['num_pages'] + 1):
                found = page_image_bytes(path, n)
                if found is None:
                    self.stderr.write(f'{name}: page {n} has no raster')
                    continue
                (outdir / f'{n}.png').write_bytes(found[0])
                if n % 25 == 0:
                    self.stdout.write(f'{name}: {n}/{meta["num_pages"]} pages…')
            meta['sha256'] = sha
            meta['filename'] = name
            meta['image_base'] = f'/prerendered/{name}/'
            meta_path.write_text(json.dumps(meta))
            self.stdout.write(self.style.SUCCESS(f"{name}: {meta['num_pages']} pages rendered"))
