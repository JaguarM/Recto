"""The font catalogue — assets/fonts/fonts.json read once, resolved everywhere.

One list of faces for the whole app: the toolbar's font menu, the @font-face
rules the browser draws vector text with, and the file HarfBuzz measures with
all come from here, so "Nimbus Roman bold" means the same file in every
place. Family names match tol0's generated set-fonts table (the face each
OCR glyph set was rendered from), which is what lets an OCR line name its
face and the text tool select it.

`python manage.py fonts_setup` builds the files the catalogue names.
"""
import json
import os
from pathlib import Path

FONT_DIR = Path(__file__).resolve().parents[2] / 'assets' / 'fonts'
CATALOG_PATH = FONT_DIR / 'fonts.json'

STYLE_KEYS = ('regular', 'bold', 'italic', 'bolditalic')
FALLBACK_FAMILY = 'Times New Roman'

_cache = {'mtime': None, 'data': None}


def catalog():
    """The parsed catalogue (cached by file mtime): {'families': [...]}."""
    try:
        mtime = os.path.getmtime(CATALOG_PATH)
    except OSError:
        return {'families': []}
    if _cache['mtime'] != mtime:
        with open(CATALOG_PATH, encoding='utf-8') as f:
            data = json.load(f)
        _cache.update(mtime=mtime, data=data)
    return _cache['data']


def families():
    """Catalogue entries with a `present` map: which style files exist on disk."""
    out = []
    for fam in catalog().get('families', []):
        files = fam.get('files', {})
        out.append({
            'family': fam['family'],
            'class': fam.get('class', ''),
            'note': fam.get('note', ''),
            'pdfNames': fam.get('pdfNames', []),
            'files': files,
            'present': {k: (FONT_DIR / v).is_file() for k, v in files.items()},
        })
    return out


def _entry(family):
    key = (family or '').strip().lower()
    for fam in catalog().get('families', []):
        if fam['family'].lower() == key:
            return fam
    return None


def style_key(bold=False, italic=False):
    return 'bolditalic' if bold and italic else 'bold' if bold else 'italic' if italic else 'regular'


def resolve(family, bold=False, italic=False):
    """Path of the file for (family, bold, italic), falling back through the
    family's styles (bold italic → bold → italic → regular) and finally to the
    fallback family's regular. None only when nothing at all is installed."""
    fam = _entry(family) or _entry(FALLBACK_FAMILY)
    if not fam:
        return None
    files = fam.get('files', {})
    want = style_key(bold, italic)
    chain = {
        'bolditalic': ('bolditalic', 'bold', 'italic', 'regular'),
        'bold': ('bold', 'regular'),
        'italic': ('italic', 'regular'),
        'regular': ('regular',),
    }[want]
    for key in chain:
        name = files.get(key)
        if name and (FONT_DIR / name).is_file():
            return str(FONT_DIR / name)
    if fam['family'] != FALLBACK_FAMILY:
        return resolve(FALLBACK_FAMILY, bold, italic)
    return None


def resolve_file(name):
    """Legacy file-name API (`font: 'times.ttf'`): the file in assets/fonts, or None."""
    if not name:
        return None
    for candidate in (Path(name), FONT_DIR / name, FONT_DIR / (name + '.ttf')):
        if candidate.is_file():
            return str(candidate)
    return None


def family_for_pdf_name(pdf_name):
    """A PDF BaseFont name (e.g. 'ABCDEF+TimesNewRomanPSMT-Bold') → catalogue
    family, or None. Longest alias wins so 'TimesNewRoman' beats 'Times'."""
    if not pdf_name:
        return None
    key = pdf_name.split('+')[-1].replace(' ', '').replace('-', '').replace(',', '').lower()
    best, best_len = None, 0
    for fam in catalog().get('families', []):
        for alias in fam.get('pdfNames', []):
            a = alias.replace(' ', '').replace('-', '').lower()
            if key.startswith(a) and len(a) > best_len:
                best, best_len = fam['family'], len(a)
    return best


def default_family():
    fam = _entry(FALLBACK_FAMILY)
    if fam and resolve(fam['family']):
        return fam['family']
    for f in families():
        if f['present'].get('regular'):
            return f['family']
    return FALLBACK_FAMILY
