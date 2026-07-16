"""Smoke tests for webgl_mask: its toolbar toggle and options bar render.

The mask-detection endpoint itself is not covered here yet; add an endpoint
test if its contract needs guarding.

Run with: python manage.py test webgl_mask
"""

from django.test import TestCase

WEBGL_DOM_IDS = ('toggle-webgl', 'webgl-options-bar', 'edge-subtract')


class WebglMaskUiTests(TestCase):
    def test_toolbar_and_options_bar_present(self):
        resp = self.client.get('/')
        self.assertEqual(resp.status_code, 200)
        html = resp.content.decode()
        for dom_id in WEBGL_DOM_IDS:
            self.assertIn(f'id="{dom_id}"', html,
                          f'webgl_mask control #{dom_id} missing from the rendered page')
