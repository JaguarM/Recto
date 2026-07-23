"""Smoke tests for embedded_text_viewer: its toolbar toggle renders, and the
span-extraction endpoint reads text out of a PDF generated in memory (no
dependency on the bundled sample document or the startup auto-load).

The endpoint has two modes:
- hash mode (GET ?hash&start&count): reads the document the core stored at
  open time, one page range at a time — how the viewer actually fetches text.
- upload mode (POST file): whole-document fallback.
Both must agree on what they extract.

Run with: python manage.py test embedded_text_viewer
"""

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings

from pdf_core.tests import TEST_STORE, make_scanned_pdf, open_document


class EmbeddedTextViewerUiTests(TestCase):
    def test_toolbar_toggle_present(self):
        resp = self.client.get('/')
        self.assertEqual(resp.status_code, 200)
        self.assertIn('id="toggle-embedded-text"', resp.content.decode())


@override_settings(RECTO_DOC_STORE=TEST_STORE)
class ExtractSpansTests(TestCase):
    def setUp(self):
        self.pdf = make_scanned_pdf(num_pages=3, text='Hello Recto')

    def test_extracts_spans_from_uploaded_pdf(self):
        upload = SimpleUploadedFile('scan.pdf', self.pdf, content_type='application/pdf')
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

    def test_hash_mode_matches_upload_mode(self):
        doc_hash = open_document(self.client, self.pdf)['sha256']

        upload = SimpleUploadedFile('scan.pdf', self.pdf, content_type='application/pdf')
        full = self.client.post('/embedded-text-viewer/api/extract-spans',
                                {'file': upload}).json()['spans']

        resp = self.client.get(
            f'/embedded-text-viewer/api/extract-spans?hash={doc_hash}&start=1&count=50')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['num_pages'], 3)
        by_hash = data['spans']

        # Same text at the same coordinates, whichever way the PDF was read.
        key = lambda s: (s['page'], s['text'], round(s['x']), round(s['y']))
        self.assertEqual(sorted(map(key, full)), sorted(map(key, by_hash)))

    def test_hash_mode_respects_page_range(self):
        doc_hash = open_document(self.client, self.pdf)['sha256']
        resp = self.client.get(
            f'/embedded-text-viewer/api/extract-spans?hash={doc_hash}&start=2&count=1')
        self.assertEqual(resp.status_code, 200)
        spans = resp.json()['spans']
        self.assertTrue(spans)
        self.assertTrue(all(s['page'] == 2 for s in spans))

    def test_lean_mode_strips_per_character_data(self):
        doc_hash = open_document(self.client, self.pdf)['sha256']
        resp = self.client.get(
            f'/embedded-text-viewer/api/extract-spans?hash={doc_hash}&start=1&count=3&lean=1')
        self.assertEqual(resp.status_code, 200)
        spans = resp.json()['spans']
        self.assertTrue(spans)
        self.assertEqual(set(spans[0]), {'page', 'text', 'x', 'y', 'w', 'h', 'sizePt', 'font'})

    def test_hash_mode_unknown_document_is_404(self):
        resp = self.client.get(
            f'/embedded-text-viewer/api/extract-spans?hash={"0" * 64}')
        self.assertEqual(resp.status_code, 404)
