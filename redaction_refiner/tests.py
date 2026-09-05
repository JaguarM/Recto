import json
import shutil
import subprocess
from pathlib import Path

from django.contrib.staticfiles import finders
from django.test import TestCase

from pdf_core.registry import PDFToolRegistry

HERE = Path(__file__).resolve().parent
STATIC = HERE / 'static' / 'redaction_refiner'


class RedactionRefinerRegistrationTests(TestCase):
    def test_tool_is_registered(self):
        tools = PDFToolRegistry.get_tools()
        self.assertIn('redaction_refiner', tools)

    def test_injects_its_script_after_app(self):
        tool = PDFToolRegistry.get_tools()['redaction_refiner']
        paths = [s['path'] for s in tool.scripts_after_app]
        self.assertIn('redaction_refiner/redaction-refiner.js', paths)

    def test_script_file_exists(self):
        self.assertTrue((STATIC / 'redaction-refiner.js').is_file())

    def test_declares_no_backend_surface(self):
        # Client-side only: no routes, no toolbar/sidebar host to leave behind.
        tool = PDFToolRegistry.get_tools()['redaction_refiner']
        self.assertIsNone(tool.url_module)
        self.assertIsNone(tool.toolbar_button)
        self.assertIsNone(tool.sidebar)


class WordListTests(TestCase):
    """words.txt is the refiner's English dictionary: one lowercase word per
    line, most frequent first (built by words_build.py)."""

    def setUp(self):
        self.words = (STATIC / 'words.txt').read_text(encoding='utf-8').split('\n')
        self.words = [w for w in self.words if w]

    def test_is_reachable_through_staticfiles(self):
        # The refiner fetches /static/redaction_refiner/words.txt at runtime.
        self.assertIsNotNone(finders.find('redaction_refiner/words.txt'))
        self.assertIsNotNone(finders.find('redaction_refiner/words.LICENSE.txt'))

    def test_shape(self):
        self.assertGreater(len(self.words), 10_000)
        self.assertEqual(len(self.words), len(set(self.words)), 'duplicates')
        bad = [w for w in self.words if not w.isascii() or not w.islower() or not w.isalpha()]
        self.assertEqual(bad, [])
        singles = [w for w in self.words if len(w) == 1]
        self.assertEqual(sorted(singles), ['a', 'i'])

    def test_frequency_order_puts_and_first_among_nd_words(self):
        # The refiner ranks fragment completions by list order: "nd" → "and".
        nd = [w for w in self.words if w.endswith('nd')]
        self.assertEqual(nd[0], 'and')
        self.assertLess(self.words.index('the'), 5)

    def test_web_junk_filtered(self):
        for junk in ('www', 'http', 'xxx', 'pdf', 'cgi', 'nd'):
            self.assertNotIn(junk, self.words)
        for word in ('including', 'and', 'the', 'device', 'financial'):
            self.assertIn(word, self.words)


class RefinerLogicTests(TestCase):
    """The refiner's geometry runs under Node with stubbed viewer globals —
    tests_js/refiner.test.mjs — against a fixture of real embedded spans."""

    def test_node_suite(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('node is not installed')
        script = HERE / 'tests_js' / 'refiner.test.mjs'
        proc = subprocess.run([node, str(script)], capture_output=True, text=True,
                              cwd=str(HERE), timeout=120)
        self.assertEqual(proc.returncode, 0,
                         f'\n--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}')

    def test_fixture_is_real_page_geometry(self):
        fx = json.loads((HERE / 'tests_js' / 'fixtures' / 'efta_rows.json').read_text(encoding='utf-8'))
        texts = [s['text'] for s in fx['spans']]
        self.assertTrue(any('including' in t for t in texts))
        self.assertTrue(any(t.startswith('nd GHISLAINE') for t in texts))
        self.assertEqual(len(fx['bars']), 2)
