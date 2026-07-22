"""Startup document resolution.

The app auto-loads a bundled document on startup. Rather than hard-coding a
filename, the startup document is whatever PDF sits directly in ``assets/pdfs/``
— swap it by replacing the file; no rename, no code change, no restart. With
more than one PDF present the alphabetically first wins, so keep exactly one
there. Subfolders are ignored on purpose (they can hold fixtures or archived
documents without becoming the startup document).

Plugins that need the same bytes import :func:`find_default_document` from
here — never re-derive the path.
"""
from pathlib import Path

DEFAULT_DOCUMENT_DIR = Path(__file__).resolve().parent.parent.parent / 'assets' / 'pdfs'


def find_default_document():
    """Path of the startup PDF, or ``None`` when ``assets/pdfs/`` holds none.

    Resolved per call (not at import), so replacing the file takes effect on
    the next request without a server restart.
    """
    if not DEFAULT_DOCUMENT_DIR.is_dir():
        return None
    pdfs = sorted(
        (p for p in DEFAULT_DOCUMENT_DIR.iterdir()
         if p.is_file() and p.suffix.lower() == '.pdf'),
        key=lambda p: p.name.lower(),
    )
    return pdfs[0] if pdfs else None
