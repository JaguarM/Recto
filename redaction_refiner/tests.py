from pathlib import Path

from django.test import TestCase

from pdf_core.registry import PDFToolRegistry


class RedactionRefinerRegistrationTests(TestCase):
    def test_tool_is_registered(self):
        tools = PDFToolRegistry.get_tools()
        self.assertIn('redaction_refiner', tools)

    def test_injects_its_script_after_app(self):
        tool = PDFToolRegistry.get_tools()['redaction_refiner']
        paths = [s['path'] for s in tool.scripts_after_app]
        self.assertIn('redaction_refiner/redaction-refiner.js', paths)

    def test_script_file_exists(self):
        script = (Path(__file__).resolve().parent
                  / 'static' / 'redaction_refiner' / 'redaction-refiner.js')
        self.assertTrue(script.is_file())

    def test_declares_no_backend_surface(self):
        # Client-side only: no routes, no toolbar/sidebar host to leave behind.
        tool = PDFToolRegistry.get_tools()['redaction_refiner']
        self.assertIsNone(tool.url_module)
        self.assertIsNone(tool.toolbar_button)
        self.assertIsNone(tool.sidebar)
