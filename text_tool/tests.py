"""Smoke tests for text_tool: the formatting UI is present in the rendered
page, and the HarfBuzz measurement endpoints answer with sane data.

The id list mirrors guide/ui-map.md — update both together whenever a control
is added, moved, renamed, or removed.

Run with: python manage.py test text_tool
"""

from django.test import TestCase

TEXT_TOOL_DOM_IDS = (
    # top toolbar
    'toggle-fmt',
    # Insert group (persistent ribbon)
    'fabric-insert-bar', 'tt-add-text-btn', 'tool-add-box',
    # formatting bar
    'fabric-options-bar',
    'fabric-font-family', 'fabric-font-size',
    'fabric-bold', 'fabric-italic', 'fabric-underline', 'fabric-strikethrough',
    'fabric-color', 'kerning', 'fabric-nudge-mode',
    'fabric-letter-spacing', 'fabric-default-sw',
    'fabric-space-width', 'fabric-space-width-display', 'toggle-space-labels',
    # Match group (redaction-only tuning; ids also read by matching plugins)
    'fabric-match-group', 'tolerance', 'force-uppercase',
)


class TextToolUiTests(TestCase):
    def test_all_controls_present_on_page(self):
        resp = self.client.get('/')
        self.assertEqual(resp.status_code, 200)
        html = resp.content.decode()
        for dom_id in TEXT_TOOL_DOM_IDS:
            self.assertIn(f'id="{dom_id}"', html,
                          f'text_tool control #{dom_id} missing from the rendered page')


class WidthEndpointTests(TestCase):
    """/widths and /fonts-list — the HarfBuzz text-measurement path."""

    def test_widths_measures_strings(self):
        resp = self.client.post('/widths', data={
            'strings': ['Hello world', ' '],
            'font': 'times.ttf',
            'size': 12,
            'kerning': True,
        }, content_type='application/json')
        self.assertEqual(resp.status_code, 200)
        results = resp.json()['results']
        self.assertEqual(len(results), 2)
        for r in results:
            self.assertGreater(r['width'], 0, f'non-positive width in {r!r}')
        # a whole phrase must measure wider than a single space
        self.assertGreater(results[0]['width'], results[1]['width'])

    def test_widths_rejects_get(self):
        self.assertEqual(self.client.get('/widths').status_code, 405)

    def test_fonts_list_returns_fonts(self):
        resp = self.client.get('/fonts-list')
        self.assertEqual(resp.status_code, 200)
        fonts = resp.json()
        self.assertIsInstance(fonts, list)
        self.assertTrue(fonts, 'no fonts reported — is assets/fonts/ present?')
