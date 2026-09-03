"""Smoke tests for ocr_tool: the OCR subtoolbar (including the MuPDF pixel
view toggles) is on the rendered page, the engine + adapter scripts are
injected in the right order, and the precomputed-cache route answers.

The engine itself is certified in the external tol0 repo (`npm test`,
`npm run certify:ftclone`, `npm run certify:render`); the browser-level proof
that the pixel view reproduces the page byte-for-byte is tol0's
`npm run recto-test`. These tests only guard the Recto wiring.

Run with: python manage.py test ocr_tool
"""

from django.test import TestCase, override_settings

OCR_TOOL_DOM_IDS = (
    'toggle-ocr-tool', 'ocr-tool-bar',
    'ocr-run-page', 'ocr-run-all', 'ocr-toggle-text', 'ocr-cancel',
    # MuPDF pixel view (pixel-view.js)
    'ocr-pixel-view', 'ocr-pixel-diff',
    'ocr-status',
)

# scripts_after_app order: the engine before the adapters that use it
OCR_TOOL_SCRIPTS = (
    'ocr_tool/engine/core.js',
    'ocr_tool/engine/ocr.js',
    'ocr_tool/engine/ocr-engine.js',
    'ocr_tool/engine/blindocr.js',
    'ocr_tool/engine/render.js',
    'ocr_tool/ocr-tool.js',
    'ocr_tool/pixel-view.js',
)


class OcrToolUiTests(TestCase):
    def test_all_controls_present_on_page(self):
        resp = self.client.get('/')
        self.assertEqual(resp.status_code, 200)
        html = resp.content.decode()
        for dom_id in OCR_TOOL_DOM_IDS:
            self.assertIn(f'id="{dom_id}"', html,
                          f'ocr_tool control #{dom_id} missing from the rendered page')

    def test_scripts_injected_in_order(self):
        html = self.client.get('/').content.decode()
        positions = []
        for path in OCR_TOOL_SCRIPTS:
            pos = html.find(path)
            self.assertNotEqual(pos, -1, f'script {path} not injected')
            positions.append(pos)
        self.assertEqual(positions, sorted(positions),
                         'ocr_tool scripts must load engine first, then the adapters')
        # Plugins load in registry (app) order, so ocr_tool's scripts come
        # BEFORE text_tool's: the pixel seam is a guarded global that
        # svg-renderer.js looks up at render time, never at load time, so the
        # order between the two plugins must not matter — assert only that both
        # halves are on the page.
        self.assertIn('text_tool/svg-renderer.js', html)


class OcrCacheRouteTests(TestCase):
    def test_miss_is_a_clean_200(self):
        resp = self.client.get('/ocr/cache/' + 'a' * 64)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {'cached': False})
        self.assertEqual(resp['Cache-Control'], 'no-store')

    def test_bad_hash_rejected(self):
        self.assertEqual(self.client.get('/ocr/cache/not-a-hash').status_code, 400)

    @override_settings(DEBUG=False)
    def test_write_is_read_only_in_production(self):
        resp = self.client.post('/ocr/cache/' + 'b' * 64, data='{"version": 2, "pages": []}',
                                content_type='application/json')
        self.assertEqual(resp.status_code, 403)
