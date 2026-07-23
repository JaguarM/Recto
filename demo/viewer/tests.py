from django.test import SimpleTestCase


class DemoViewsTests(SimpleTestCase):
    def test_index_renders_landing(self):
        r = self.client.get('/')
        self.assertEqual(r.status_code, 200)
        html = r.content.decode()
        for needle in ('drop-zone', 'att-panel', 'att-cards', 'att-rescan',
                       'ocr-pill', 'ocr_tool/engine/blindocr.js'):
            self.assertIn(needle, html)
        # the confusing manual scan button must not exist in the demo
        self.assertNotIn('b64-scan', html)

    def test_index_lists_bundled_sample(self):
        r = self.client.get('/')
        self.assertIn('sample-card', r.content.decode())

    def test_open_sample_returns_metadata(self):
        r = self.client.get('/open-sample/EFTA00434905.pdf')
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertIn('sha256', data)
        self.assertGreaterEqual(data['num_pages'], 1)
        # page 1 raster is servable by hash
        img = self.client.get(f"/page-image/{data['sha256']}/1")
        self.assertEqual(img.status_code, 200)
        self.assertTrue(img['Content-Type'].startswith('image/'))

    def test_unknown_sample_404(self):
        r = self.client.get('/open-sample/nope.pdf')
        self.assertEqual(r.status_code, 404)

    def test_upload_rejects_non_pdf(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        f = SimpleUploadedFile('note.txt', b'hello', content_type='text/plain')
        r = self.client.post('/open-document', {'file': f})
        self.assertEqual(r.status_code, 400)
