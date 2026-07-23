"""Smoke tests for webgl_mask: its toolbar controls render, and the per-page
mask endpoint detects a redaction rectangle in a PDF generated in memory.

Run with: python manage.py test webgl_mask
"""

import io

from django.test import TestCase, override_settings
from PIL import Image

from pdf_core.tests import TEST_STORE, make_scanned_pdf, open_document

WEBGL_DOM_IDS = ('toggle-webgl', 'webgl-options-bar', 'edge-subtract')


class WebglMaskUiTests(TestCase):
    def test_toolbar_and_options_bar_present(self):
        resp = self.client.get('/')
        self.assertEqual(resp.status_code, 200)
        html = resp.content.decode()
        for dom_id in WEBGL_DOM_IDS:
            self.assertIn(f'id="{dom_id}"', html,
                          f'webgl_mask control #{dom_id} missing from the rendered page')


@override_settings(RECTO_DOC_STORE=TEST_STORE)
class PageMaskTests(TestCase):
    """/webgl/mask/<hash>/<n> — on-demand detection on the stored document."""

    def setUp(self):
        # Page 1 carries a solid black rectangle inside its raster; page 2 is clean.
        pdf = make_scanned_pdf(num_pages=2, redaction_on_page=1)
        self.doc_hash = open_document(self.client, pdf)['sha256']

    def test_redacted_page_yields_a_mask(self):
        resp = self.client.get(f'/webgl/mask/{self.doc_hash}/1')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp['Content-Type'], 'image/png')
        with Image.open(io.BytesIO(resp.content)) as mask:
            self.assertEqual(mask.mode, 'L')
            # The detected rectangle shows up as white (255) interior pixels.
            self.assertEqual(mask.getextrema()[1], 255)

    def test_clean_page_is_204(self):
        resp = self.client.get(f'/webgl/mask/{self.doc_hash}/2')
        self.assertEqual(resp.status_code, 204)

    def test_unknown_document_is_404(self):
        resp = self.client.get(f'/webgl/mask/{"0" * 64}/1')
        self.assertEqual(resp.status_code, 404)
