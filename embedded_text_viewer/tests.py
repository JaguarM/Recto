"""Smoke tests for embedded_text_viewer: its toolbar toggle renders, and the
span-extraction endpoint reads text out of a PDF generated in memory (no
dependency on the bundled sample document or the startup auto-load).

Note: the extractor only processes pages that carry an embedded raster image
(scanned-document style), so the test PDF contains a full-page PNG *and* text.

Run with: python manage.py test embedded_text_viewer
"""

import io

import fitz
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from PIL import Image


def make_scanned_pdf_with_text(text='Hello Recto'):
    buf = io.BytesIO()
    Image.new('RGB', (816, 1056), 'white').save(buf, format='PNG')
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_image(fitz.Rect(0, 0, 612, 792), stream=buf.getvalue())
    page.insert_text((72, 100), text, fontsize=12)
    data = doc.tobytes()
    doc.close()
    return data


class EmbeddedTextViewerUiTests(TestCase):
    def test_toolbar_toggle_present(self):
        resp = self.client.get('/')
        self.assertEqual(resp.status_code, 200)
        self.assertIn('id="toggle-embedded-text"', resp.content.decode())


class ExtractSpansTests(TestCase):
    def test_extracts_spans_from_uploaded_pdf(self):
        upload = SimpleUploadedFile('scan.pdf', make_scanned_pdf_with_text(),
                                    content_type='application/pdf')
        resp = self.client.post('/embedded-text-viewer/api/extract-spans', {'file': upload})
        self.assertEqual(resp.status_code, 200)
        spans = resp.json()['spans']
        self.assertTrue(spans, 'no spans extracted from the test PDF')
        for key in ('text', 'sizePt', 'x', 'y', 'w', 'h'):
            self.assertIn(key, spans[0])
        self.assertTrue(any('Hello Recto' in (s.get('text') or '') for s in spans))

    def test_rejects_missing_file(self):
        resp = self.client.post('/embedded-text-viewer/api/extract-spans')
        self.assertEqual(resp.status_code, 400)
