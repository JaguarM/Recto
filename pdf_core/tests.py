"""Smoke tests for the core: the page shell renders, every registered plugin's
declared files exist, and the lazy document pipeline works — open stores the
document and returns metadata, pages are served one at a time by hash.

Design notes:
- Startup-independent: nothing here touches the bundled sample document
  except the one /open-default test. Test documents are generated in memory,
  so changing the startup PDF never breaks this suite.
- Plugin-agnostic: the registry tests iterate whatever plugins are installed
  without naming any. Plugin-specific UI and endpoints are asserted in each
  plugin's own tests.py, so deleting a plugin folder removes its tests too.
- The document store is pointed at a temp dir (RECTO_DOC_STORE) so tests
  never touch the real media/doc_cache.

Run with: python manage.py test pdf_core
"""

import io
import tempfile

import fitz
from django.contrib.staticfiles import finders
from django.core.files.uploadedfile import SimpleUploadedFile
from django.template.loader import get_template
from django.test import TestCase, override_settings
from PIL import Image, ImageDraw

from pdf_core.logic import document_store
from pdf_core.logic import geometry as geo
from pdf_core.registry import PDFToolRegistry

# DOM ids the core's own scripts look up (`els` in state.js, plus the upload
# button and the bar host). If one vanishes from index.html, core JS silently
# stops working — this list is that contract. tool-add-box / tool-text are
# looked up by the core but owned by a plugin, so the owning plugin's tests
# assert them instead. Keep in sync with guide/ui-map.md.
CORE_DOM_IDS = (
    'drag-overlay', 'viewer-container', 'viewer', 'document-title',
    'page-count', 'page-input', 'zoom-input', 'zoom-in', 'zoom-out',
    'sidebar', 'toggle-sidebar', 'thumbnail-view', 'prev-page', 'next-page',
    'pdf-file', 'upload-pdf-btn', 'unified-options-bar-container',
)

# Static files index.html hardcodes (everything else is declared per-plugin
# and covered by RegistryDeclarationTests). text_tool/geometry.js is the one
# core→plugin static dependency: the JS mirror of pdf_core/logic/geometry.py.
CORE_STATIC_FILES = (
    'pdf_core/hooks.js',
    'text_tool/geometry.js',
    'pdf_core/state.js',
    'pdf_core/pdf-viewer.js',
    'pdf_core/ui-events.js',
    'pdf_core/app.js',
    'pdf_core/styles.css',
    'pdf_core/favicon.ico',
)

TEST_STORE = tempfile.mkdtemp(prefix='recto-test-doc-store-')


def make_text_pdf(text='Hello Recto'):
    """A one-page PDF containing only embedded text (no raster image)."""
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)  # US Letter, in points
    page.insert_text((72, 100), text, fontsize=12)
    data = doc.tobytes()
    doc.close()
    return data


def make_scanned_pdf(num_pages=1, text=None, redaction_on_page=None):
    """A scanned-style PDF: each page is a full-page PNG raster, optionally
    with an embedded text layer on top and/or a solid black rectangle inside
    the raster on one page (what the mask detector looks for)."""
    doc = fitz.open()
    for i in range(num_pages):
        img = Image.new('RGB', (geo.PAGE_WIDTH_PX, geo.PAGE_HEIGHT_PX), 'white')
        if redaction_on_page == i + 1:
            ImageDraw.Draw(img).rectangle([100, 100, 300, 160], fill=(0, 0, 0))
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        page = doc.new_page(width=612, height=792)
        page.insert_image(fitz.Rect(0, 0, 612, 792), stream=buf.getvalue())
        if text:
            page.insert_text((72, 100), f'{text} page {i + 1}', fontsize=12)
    data = doc.tobytes()
    doc.close()
    return data


def open_document(client, pdf_bytes, name='doc.pdf', content_type='application/pdf'):
    """POST bytes to /open-document and return the parsed payload."""
    upload = SimpleUploadedFile(name, pdf_bytes, content_type=content_type)
    resp = client.post('/open-document', {'file': upload})
    assert resp.status_code == 200, resp.content
    return resp.json()


class IndexPageTests(TestCase):
    def test_page_renders_with_all_core_controls(self):
        resp = self.client.get('/')
        self.assertEqual(resp.status_code, 200)
        html = resp.content.decode()
        for dom_id in CORE_DOM_IDS:
            self.assertIn(f'id="{dom_id}"', html,
                          f'core control #{dom_id} missing from the rendered page')


class RegistryDeclarationTests(TestCase):
    """Every file a plugin declares in its tool.py must actually exist.

    Catches the classic breakage: a template or script gets renamed/deleted
    but its tool.py declaration is left pointing at the old name.
    """

    def test_declared_templates_exist_and_parse(self):
        for name, tool in PDFToolRegistry.get_tools().items():
            for slot in ('toolbar_button', 'options_bar', 'ribbon_bar', 'sidebar'):
                path = getattr(tool, slot, None)
                if not path:
                    continue
                try:
                    get_template(path)  # raises if missing or syntactically broken
                except Exception as e:
                    self.fail(f'{name}.{slot} = {path!r} failed to load: {e}')

    def test_declared_static_files_exist(self):
        for name, tool in PDFToolRegistry.get_tools().items():
            declared = list(tool.styles) + list(tool.scripts_before_viewer) + list(tool.scripts_after_app)
            for entry in declared:
                self.assertIsNotNone(finders.find(entry['path']),
                                     f'{name} declares a missing static file: {entry["path"]}')

    def test_core_static_files_exist(self):
        for path in CORE_STATIC_FILES:
            self.assertIsNotNone(finders.find(path),
                                 f'index.html references a missing static file: {path}')


@override_settings(RECTO_DOC_STORE=TEST_STORE)
class OpenDocumentTests(TestCase):
    """/open-document — metadata only; the document body stays on the server."""

    def test_rejects_missing_file(self):
        resp = self.client.post('/open-document')
        self.assertEqual(resp.status_code, 400)

    def test_open_returns_metadata_not_content(self):
        data = open_document(self.client, make_scanned_pdf(num_pages=3, text='Body'))
        self.assertNotIn('error', data)
        self.assertEqual(data['num_pages'], 3)
        self.assertEqual(len(data['sha256']), 64)
        self.assertEqual(data['page_width'], geo.PAGE_WIDTH_PX)
        self.assertEqual(data['page_height'], geo.PAGE_HEIGHT_PX)
        self.assertIn('suggested_size', data)
        self.assertIn('suggested_scale', data)
        # The whole point of the lazy pipeline: no inline page images or spans.
        self.assertNotIn('page_images', data)
        self.assertNotIn('spans', data)

    def test_text_pdf_reports_typography(self):
        data = open_document(self.client, make_text_pdf())
        self.assertEqual(data['num_pages'], 1)
        self.assertEqual(data['suggested_size'], 12.0)
        self.assertTrue(data['pdf_fonts'], 'declared fonts should be reported')

    def test_plain_image_opens_as_one_page_document(self):
        buf = io.BytesIO()
        Image.new('RGB', (200, 100), 'white').save(buf, format='PNG')
        data = open_document(self.client, buf.getvalue(), name='page.png',
                             content_type='image/png')
        self.assertEqual(data['num_pages'], 1)
        self.assertEqual(data['page_width'], 200)
        self.assertEqual(data['page_height'], 100)

    def test_reopening_same_bytes_is_deduplicated(self):
        pdf = make_scanned_pdf()
        first = open_document(self.client, pdf)
        second = open_document(self.client, pdf)
        self.assertEqual(first['sha256'], second['sha256'])
        stored = list(document_store.store_dir().glob(f"{first['sha256']}.*"))
        self.assertEqual(len(stored), 1)


@override_settings(RECTO_DOC_STORE=TEST_STORE)
class PageImageTests(TestCase):
    """/page-image/<hash>/<n> — per-page rasters, served on demand."""

    def test_serves_the_embedded_page_raster(self):
        data = open_document(self.client, make_scanned_pdf(num_pages=2))
        resp = self.client.get(f"/page-image/{data['sha256']}/1")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp['Content-Type'], 'image/png')
        self.assertIn('immutable', resp['Cache-Control'])
        with Image.open(io.BytesIO(resp.content)) as img:
            self.assertEqual(img.size, (geo.PAGE_WIDTH_PX, geo.PAGE_HEIGHT_PX))

    def test_renders_pages_without_embedded_raster(self):
        # Born-digital pages have no scan image; the endpoint falls back to a
        # 96-DPI render so the viewer never shows a blank page.
        data = open_document(self.client, make_text_pdf())
        resp = self.client.get(f"/page-image/{data['sha256']}/1")
        self.assertEqual(resp.status_code, 200)
        with Image.open(io.BytesIO(resp.content)) as img:
            self.assertEqual(img.size, (geo.PAGE_WIDTH_PX, geo.PAGE_HEIGHT_PX))

    def test_thumbnail_variant_is_small(self):
        data = open_document(self.client, make_scanned_pdf())
        resp = self.client.get(f"/page-image/{data['sha256']}/1?thumb=1")
        self.assertEqual(resp.status_code, 200)
        with Image.open(io.BytesIO(resp.content)) as img:
            self.assertEqual(img.width, 180)

    def test_serves_plain_image_documents(self):
        buf = io.BytesIO()
        Image.new('RGB', (200, 100), 'blue').save(buf, format='PNG')
        data = open_document(self.client, buf.getvalue(), name='page.png',
                             content_type='image/png')
        resp = self.client.get(f"/page-image/{data['sha256']}/1")
        self.assertEqual(resp.status_code, 200)
        with Image.open(io.BytesIO(resp.content)) as img:
            self.assertEqual(img.size, (200, 100))

    def test_unknown_inputs_are_404(self):
        data = open_document(self.client, make_scanned_pdf())
        for url in (
            f"/page-image/{data['sha256']}/99",   # page out of range
            f"/page-image/{'0' * 64}/1",          # unknown document
            "/page-image/not-a-hash/1",           # malformed hash
        ):
            self.assertEqual(self.client.get(url).status_code, 404, url)


@override_settings(RECTO_DOC_STORE=TEST_STORE)
class OpenDefaultTests(TestCase):
    def test_default_document_uses_the_same_pipeline(self):
        resp = self.client.get('/open-default')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('default_filename', data)
        self.assertNotIn('page_images', data)
        page = self.client.get(f"/page-image/{data['sha256']}/1")
        self.assertEqual(page.status_code, 200)


@override_settings(RECTO_DOC_STORE=TEST_STORE)
class DocumentStoreTests(TestCase):
    def test_store_evicts_beyond_cap(self):
        hashes = [document_store.save_bytes(b'%PDF-fake-' + bytes([i]), f'doc{i}.pdf')
                  for i in range(document_store.MAX_DOCS + 3)]
        stored = [p for p in document_store.store_dir().glob('*.*')
                  if document_store.HASH_RE.match(p.stem)]
        self.assertLessEqual(len(stored), document_store.MAX_DOCS)
        # The most recently saved document always survives eviction.
        self.assertIsNotNone(document_store.find(hashes[-1]))

    def test_find_rejects_malformed_hashes(self):
        self.assertIsNone(document_store.find('../../etc/passwd'))
        self.assertIsNone(document_store.find(''))
        self.assertIsNone(document_store.find(None))
