"""Server-side store of opened documents, keyed by content SHA-256.

``/open-document`` streams every upload in here once; after that, everything
the frontend or a plugin needs (page rasters, text spans, masks) is served
from the stored file by hash — the browser never re-uploads the document and
the server never holds all of it in memory. The hash is the same ``sha256``
the open payload reports, so plugins key their requests off ``state.docHash``.

Files live in ``media/doc_cache/<sha256><ext>`` (``media/`` is gitignored).
The store keeps the most recently used handful of documents and silently
evicts the oldest beyond that — a cache, not an archive.
"""

import hashlib
import os
import re
import uuid
from pathlib import Path

from django.conf import settings

HASH_RE = re.compile(r'^[0-9a-f]{64}$')

# Uploads are dispatched to the PDF or image loader by extension; anything
# unrecognized is stored as .pdf (open_document's own dispatch default).
_KNOWN_EXTS = {'.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'}

MAX_DOCS = 5  # LRU cap — at ~half a GB per large document this bounds disk use


def store_dir() -> Path:
    """Resolved at call time so tests can point RECTO_DOC_STORE at a tmp dir."""
    configured = getattr(settings, 'RECTO_DOC_STORE', None)
    return Path(configured) if configured else Path(settings.BASE_DIR) / 'media' / 'doc_cache'


def safe_ext(name) -> str:
    ext = os.path.splitext(name or '')[1].lower()
    return ext if ext in _KNOWN_EXTS else '.pdf'


def find(doc_hash) -> Path | None:
    """Path of a stored document, or None. Rejects malformed hashes outright."""
    if not doc_hash or not HASH_RE.match(doc_hash):
        return None
    matches = list(store_dir().glob(f'{doc_hash}.*'))
    if not matches:
        return None
    path = matches[0]
    # Touch for LRU: most recently opened documents survive eviction longest.
    try:
        os.utime(path, None)
    except OSError:
        pass
    return path


def save_upload(django_file, ext=None) -> str:
    """Stream an uploaded file into the store; returns its sha256.

    Hashes while writing so the upload is read exactly once and never held in
    memory as a whole (Django already spooled anything big to a temp file).
    ``ext`` overrides the extension derived from the upload's filename.
    """
    directory = store_dir()
    directory.mkdir(parents=True, exist_ok=True)
    tmp_path = directory / f'.incoming-{uuid.uuid4().hex}'
    digest = hashlib.sha256()
    try:
        with open(tmp_path, 'wb') as out:
            for chunk in django_file.chunks():
                digest.update(chunk)
                out.write(chunk)
        doc_hash = digest.hexdigest()
        final = directory / f'{doc_hash}{ext or safe_ext(django_file.name)}'
        if final.exists():
            tmp_path.unlink()
            os.utime(final, None)
        else:
            tmp_path.replace(final)
    finally:
        tmp_path.unlink(missing_ok=True)
    _evict(keep=doc_hash)
    return doc_hash


def save_bytes(data: bytes, name: str) -> str:
    """Store in-memory bytes (the bundled startup document); returns sha256."""
    directory = store_dir()
    directory.mkdir(parents=True, exist_ok=True)
    doc_hash = hashlib.sha256(data).hexdigest()
    final = directory / f'{doc_hash}{safe_ext(name)}'
    if final.exists():
        os.utime(final, None)
    else:
        final.write_bytes(data)
    _evict(keep=doc_hash)
    return doc_hash


def _evict(keep: str):
    """Drop the oldest stored documents beyond MAX_DOCS (never the one just saved)."""
    entries = [p for p in store_dir().glob('*.*') if HASH_RE.match(p.stem)]
    entries.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for path in entries[MAX_DOCS:]:
        if path.stem == keep:
            continue
        try:
            path.unlink()
        except OSError:
            pass
