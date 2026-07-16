"""Smoke tests for the core: the page shell renders, every registered plugin's
declared files exist, and document opening works.

Design notes:
- Startup-independent: nothing here touches /open-default or the bundled
  sample document. Test documents are generated in memory, so changing how
  the app loads a PDF on startup never breaks this suite.
- Plugin-agnostic: the registry tests iterate whatever plugins are installed
  without naming any. Plugin-specific UI and endpoints are asserted in each
  plugin's own tests.py, so deleting a plugin folder removes its tests too.

Run with: python manage.py test pdf_core
"""

import io

import fitz
from django.contrib.staticfiles import finders
from django.core.files.uploadedfile import SimpleUploadedFile
from django.template.loader import get_template
from django.test import TestCase
from PIL import Image

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


def make_text_pdf(text='Hello Recto'):
    """A one-page PDF containing only embedded text (no raster image)."""
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)  # US Letter, in points
    page.insert_text((72, 100), text, fontsize=12)
    data = doc.tobytes()
    doc.close()
    return data


def make_scanned_pdf():
    """A one-page PDF whose content is a full-page PNG raster, like a scan."""
    buf = io.BytesIO()
    Image.new('RGB', (geo.PAGE_WIDTH_PX, geo.PAGE_HEIGHT_PX), 'white').save(buf, format='PNG')
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_image(fitz.Rect(0, 0, 612, 792), stream=buf.getvalue())
    data = doc.tobytes()
    doc.close()
    return data


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


class OpenDocumentTests(TestCase):
    """/open-document — the core's single ingestion endpoint."""

    def test_rejects_missing_file(self):
        resp = self.client.post('/open-document')
        self.assertEqual(resp.status_code, 400)

    def test_opens_text_pdf_and_returns_spans(self):
        upload = SimpleUploadedFile('t.pdf', make_text_pdf(), content_type='application/pdf')
        resp = self.client.post('/open-document', {'file': upload})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertNotIn('error', data)
        self.assertEqual(data['num_pages'], 1)
        self.assertEqual(data['page_width'], geo.PAGE_WIDTH_PX)
        self.assertEqual(data['page_height'], geo.PAGE_HEIGHT_PX)
        texts = [s['text'] for s in data['spans']]
        self.assertTrue(any('Hello Recto' in t for t in texts),
                        f'expected span text not found in {texts!r}')

    def test_opens_scanned_pdf_and_returns_page_raster(self):
        upload = SimpleUploadedFile('scan.pdf', make_scanned_pdf(), content_type='application/pdf')
        resp = self.client.post('/open-document', {'file': upload})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['num_pages'], 1)
        self.assertTrue(data['page_images'][0], 'embedded page raster was not extracted')

    def test_opens_plain_image_as_one_page_document(self):
        buf = io.BytesIO()
        Image.new('RGB', (200, 100), 'white').save(buf, format='PNG')
        upload = SimpleUploadedFile('page.png', buf.getvalue(), content_type='image/png')
        resp = self.client.post('/open-document', {'file': upload})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['num_pages'], 1)
        self.assertTrue(data['page_images'][0])
        self.assertEqual(data['spans'], [])
