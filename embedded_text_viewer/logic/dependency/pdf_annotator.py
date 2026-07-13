from __future__ import annotations

import fitz

from unredact.types.text_overlay import TextOverlay


class PdfAnnotator:
    def annotate(
        self,
        pdf_bytes: bytes,
        overlays: list[TextOverlay],
        text_color: tuple[float, float, float],
    ) -> bytes:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        by_page: dict[int, list[TextOverlay]] = {}
        for o in overlays:
            by_page.setdefault(o.page_index, []).append(o)

        for page_index, page_overlays in by_page.items():
            if page_index >= doc.page_count:
                continue
            page = doc.load_page(page_index)
            ph = page.rect.height
            for o in page_overlays:
                try:
                    page.insert_text(
                        (o.x, ph - o.y),
                        o.text,
                        fontsize=max(o.font_size_pt, 1.0),
                        color=text_color,
                    )
                except Exception:
                    pass

        out = doc.tobytes(garbage=4, deflate=True)
        doc.close()
        return out
