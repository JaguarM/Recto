import shutil
import subprocess
from pathlib import Path

from django.test import TestCase

from pdf_core.registry import PDFToolRegistry

HERE = Path(__file__).resolve().parent
API_JS = HERE / 'static' / 'redaction_matching' / 'api.js'


class RedactionMatchingTests(TestCase):
    def test_tool_is_registered_with_its_sidebar(self):
        tool = PDFToolRegistry.get_tools()['redaction_matching']
        self.assertEqual(tool.sidebar, 'redaction_matching/sidebar_tools.html')
        self.assertEqual(tool.scripts_before_viewer[0]['path'], 'redaction_matching/api.js')

    def test_index_renders_sidebar_controls(self):
        html = self.client.get('/').content.decode('utf-8')
        # Multi-letter filter (replaced the one-character first/last-letter fields).
        self.assertIn('id="ns-starts-with"', html)
        self.assertIn('id="ns-ends-with"', html)
        self.assertNotIn('ns-first-letter', html)
        self.assertNotIn('maxlength="1"', html)
        # The matches table, where tied names are picked / cycled.
        self.assertIn('id="all-matches-body"', html)
        self.assertIn('press [ / ]', html)
        # Script served with its cache-busting version.
        version = PDFToolRegistry.get_tools()['redaction_matching'].scripts_before_viewer[0]['version']
        self.assertIn(f'redaction_matching/api.js?{version}', html)

    def test_api_js_has_no_stale_letter_filter(self):
        src = API_JS.read_text(encoding='utf-8')
        self.assertNotIn('firstLetter', src)
        self.assertNotIn('lastLetter', src)
        # Faces resolve through the font catalogue, not a file-name map; the
        # widths are plain advances (no ligatures), as a Word page lays them.
        self.assertNotIn('fontFamilyToTtf', src)
        self.assertIn('ligatures: false', src)
        for name in ('matchesLetterFilter', 'getBoxMatchInfo', 'getBoxMatches', 'setBoxMatch',
                     'cycleBoxMatch', 'effectiveTolerance', 'scoreMatches', 'linkFor', 'pairReadings'):
            self.assertRegex(src, rf'function {name}\(')

    def test_node_suite(self):
        # Width matching (pixel tolerance vs the pen-exact lattice, the loose
        # fallback, verdict ranking) runs under Node with the viewer stubbed.
        node = shutil.which('node')
        if not node:
            self.skipTest('node is not installed')
        proc = subprocess.run([node, str(HERE / 'tests_js' / 'matching.test.mjs')],
                              capture_output=True, text=True, cwd=str(HERE), timeout=120)
        self.assertEqual(proc.returncode, 0,
                         f'\n--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}')

    def test_version_is_bumped_with_the_script(self):
        # The version string is the browser cache key: it must be a v=N literal.
        version = PDFToolRegistry.get_tools()['redaction_matching'].scripts_before_viewer[0]['version']
        self.assertRegex(version, r'^v=\d+$')
        self.assertGreaterEqual(int(version[2:]), 17)
