"""Smoke tests for text_tool: the formatting UI is present in the rendered
page, the font catalogue resolves faces, and the HarfBuzz measurement
endpoints answer with sane data.

The id list mirrors guide/ui-map.md — update both together whenever a control
is added, moved, renamed, or removed.

Run with: python manage.py test text_tool
"""

import json

from django.conf import settings
from django.test import TestCase

from text_tool.logic import fonts

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
    # Box group (applies to any selection)
    'utb-delete-box',
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

    def test_added_text_is_not_part_of_an_extractable_layer(self):
        """Text the user types is a 'harfbuzz' box, never 'embedded'/'ocr':
        those layers are shown and hidden wholesale by their toggles, and text
        just typed must not vanish with them."""
        src = (settings.BASE_DIR / 'text_tool' / 'static' / 'text_tool' / 'text-tool.js').read_text(encoding='utf-8')
        add_text = src[src.index('window.handleManualAddText'):]
        self.assertIn("type: 'harfbuzz'", add_text)

    def test_catalogue_script_loads_before_the_toolbar(self):
        html = self.client.get('/').content.decode()
        self.assertLess(html.find('text_tool/fonts.js'), html.find('text_tool/toolbar.js'))


class FontCatalogueTests(TestCase):
    """assets/fonts/fonts.json — one list of faces for the menu, the browser
    (@font-face) and HarfBuzz. `python manage.py fonts_setup` builds the files."""

    def test_catalogue_names_mupdf_faces_and_windows_faces(self):
        names = [f['family'] for f in fonts.families()]
        for fam in ('Nimbus Roman', 'Nimbus Sans', 'Nimbus Mono PS', 'Times New Roman', 'Courier New', 'Arial'):
            self.assertIn(fam, names)
        self.assertEqual(names[0], 'Nimbus Roman', 'MuPDF\'s own faces come first in the menu')

    def test_every_family_has_its_regular_file(self):
        missing = [f['family'] for f in fonts.families() if not f['present'].get('regular')]
        self.assertEqual(missing, [], f'run: python manage.py fonts_setup — missing {missing}')

    def test_resolve_falls_back_through_styles(self):
        regular = fonts.resolve('Nimbus Mono PS')
        self.assertTrue(regular and regular.endswith('NimbusMonoPS-Regular.otf'))
        # no bold file for Nimbus Mono PS → the regular
        self.assertEqual(fonts.resolve('Nimbus Mono PS', bold=True), regular)
        bold = fonts.resolve('Times New Roman', bold=True)
        self.assertTrue(bold.endswith('timesbd.ttf'))
        # an unknown family → the fallback family
        self.assertTrue(fonts.resolve('No Such Face').endswith('times.ttf'))

    def test_pdf_font_names_map_to_families(self):
        self.assertEqual(fonts.family_for_pdf_name('ABCDEF+TimesNewRomanPSMT'), 'Times New Roman')
        self.assertEqual(fonts.family_for_pdf_name('Times-Bold'), 'Nimbus Roman')
        self.assertEqual(fonts.family_for_pdf_name('Helvetica-Bold'), 'Nimbus Sans')
        self.assertEqual(fonts.family_for_pdf_name('Courier'), 'Nimbus Mono PS')
        self.assertIsNone(fonts.family_for_pdf_name('Wingdings'))

    def test_fonts_list_endpoint_returns_the_catalogue(self):
        resp = self.client.get('/fonts-list')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('families', data)
        self.assertEqual(data['static'], '/static/fonts/')
        self.assertTrue(any(f['family'] == 'Nimbus Roman' and f['present']['regular'] for f in data['families']))


class WidthEndpointTests(TestCase):
    """/widths — the HarfBuzz text-measurement path, faces named the catalogue way."""

    def test_widths_measures_strings_by_family(self):
        resp = self.client.post('/widths', data={
            'strings': ['Hello world', ' '],
            'family': 'Nimbus Roman',
            'size': 12,
            'kerning': True,
        }, content_type='application/json')
        self.assertEqual(resp.status_code, 200)
        results = resp.json()['results']
        self.assertEqual(len(results), 2)
        for r in results:
            self.assertGreater(r['width'], 0, f'non-positive width in {r!r}')
        self.assertGreater(results[0]['width'], results[1]['width'])

    def test_bold_measures_wider_than_regular(self):
        def width(bold):
            resp = self.client.post('/widths', data={'strings': ['Hello world'], 'family': 'Times New Roman',
                                                     'bold': bold, 'size': 12}, content_type='application/json')
            return resp.json()['results'][0]['width']
        self.assertGreater(width(True), width(False))

    def test_legacy_font_file_name_still_works(self):
        resp = self.client.post('/widths', data={'strings': ['Hello'], 'font': 'times.ttf', 'size': 12},
                                content_type='application/json')
        self.assertEqual(resp.status_code, 200)
        self.assertGreater(resp.json()['results'][0]['width'], 0)

    def test_widths_without_ligatures_are_the_plain_advances(self):
        # HarfBuzz shapes "ff" and "tt" into ligatures by default (Calibri
        # has them); a caller matching a page set without them asks for the
        # plain hmtx sum.
        def widths(**extra):
            body = {'strings': ['Groff', 'Grof', 'f', 'Barnett', 'Barnet', 't'],
                    'family': 'Calibri', 'size': 12, 'scale': 133.3333, 'kerning': False, **extra}
            r = self.client.post('/widths', data=json.dumps(body), content_type='application/json')
            self.assertEqual(r.status_code, 200)
            return [x['width'] for x in r.json()['results']]
        shaped = widths()
        plain = widths(ligatures=False)
        self.assertLess(shaped[0], shaped[1] + shaped[2] - 0.3, 'ligatures on: Groff narrower than Grof + f')
        self.assertAlmostEqual(plain[0], plain[1] + plain[2], places=3)
        self.assertAlmostEqual(plain[3], plain[4] + plain[5], places=3)

    def test_widths_rejects_get(self):
        self.assertEqual(self.client.get('/widths').status_code, 405)
