"""Open a document and describe it — the core's only ingestion path.

This module knows how to describe a stored PDF or raw image to the viewer
(page count, geometry, typography) and how to produce any single page's
raster on demand. It deliberately knows nothing about what any plugin will
*do* with that document. Analysis of any kind belongs to a plugin, which
layers itself on top via the ``document:loaded`` hook.

Documents are read from the path the document store saved them to
(``document_store``); nothing here holds a whole document in memory. The open
payload carries only metadata — page images are served one at a time by the
``/page-image`` endpoint via :func:`page_image_bytes`.

Coordinates follow ``pdf_core.logic.geometry``: everything the frontend touches
is in image pixel space (96 DPI), while font sizes stay in points.
"""

from collections import Counter
from io import BytesIO

import fitz
from PIL import Image

from . import geometry as geo

# Typography metadata (suggested body size) is sampled from the first pages —
# enough signal on any real document, and it keeps opening a multi-thousand-
# page file fast. Declared fonts are still collected from every page (cheap).
_SPAN_SAMPLE_PAGES = 25

_THUMB_WIDTH = 180  # px — matches the thumbnail sidebar's rendered width

_IMAGE_MIMES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp',
    '.webp': 'image/webp',
}


def crop_to_page_ratio(img_bytes):
    """Crop excess bottom pixels so an embedded page image matches the standard
    8.5x11 page ratio (``geo.PAGE_ASPECT``) that the pixel coordinate space
    assumes.

    Returns the (possibly re-encoded) PNG bytes; on any failure returns the input
    bytes unchanged. This is the only pixel-altering step between the embedded
    image and anything that measures it, so plugins that analyse page rasters
    must run on the output of this function to stay in the same pixel space as
    the viewer.
    """
    try:
        with Image.open(BytesIO(img_bytes)) as pil_img:
            if pil_img.mode not in ("RGB", "RGBA", "L"):
                pil_img = pil_img.convert("RGB")
            w, h = pil_img.size
            expected_h = int(round(w * geo.PAGE_ASPECT))
            if h > expected_h:
                pil_img = pil_img.crop((0, 0, w, expected_h))
                out_io = BytesIO()
                pil_img.save(out_io, format="PNG")
                return out_io.getvalue()
    except Exception as e:
        print(f"Error checking/cropping image dimensions: {e}")
    return img_bytes


def _first_raster(doc, page_index):
    """The first usable embedded raster on one page of an open PyMuPDF ``doc``.

    Returns ``(page_num, page, xref, img_bytes, img_w, img_h, img_rect)`` or
    None. The cropping here is the contract every raster consumer shares —
    identical pixels for the viewer, OCR, and mask analysis.
    """
    page = doc[page_index]
    page_num = page_index + 1
    try:
        image_list = doc.get_page_images(page_index)
    except Exception as e:
        print(f"Error extracting images on page {page_num}: {e}")
        return None

    for img_info in image_list:
        xref = img_info[0]
        try:
            base_image = doc.extract_image(xref)
            if not base_image:
                continue
            if base_image.get("ext", "").lower() not in ("png", "tiff", "tif"):
                continue

            img_bytes = crop_to_page_ratio(base_image["image"])
            with Image.open(BytesIO(img_bytes)) as pil_img:
                img_w, img_h = pil_img.size

            image_rects = page.get_image_rects(xref)
            img_rect = image_rects[0] if image_rects else None

            return page_num, page, xref, img_bytes, img_w, img_h, img_rect
        except Exception as e:
            print(f"Error processing image xref {xref} on page {page_num}: {e}")
    return None


def iter_page_rasters(doc):
    """Yield ``(page_num, page, xref, img_bytes, img_w, img_h, img_rect)`` for
    the first usable embedded raster on each page of an open PyMuPDF ``doc``.

    Shared by the loader and by any plugin that needs to analyse the *same*
    pixels the user is looking at — going through here guarantees identical
    cropping, so a plugin's coordinates line up with the rendered page.
    """
    for page_index in range(len(doc)):
        found = _first_raster(doc, page_index)
        if found:
            yield found


def _suggested_size(spans):
    """Mode of body-text span sizes, rounded to the nearest 0.5 pt.

    Prefers long spans (>= 20 chars) as the body-text signal, falling back to
    every span on documents too sparse to have any.
    """
    def sizes_of(min_len):
        return [
            round(s["font"]["size"] * 2) / 2
            for s in spans
            if len(s.get("text", "")) >= min_len and s["font"]["size"] > 0
        ]

    sizes = sizes_of(20) or sizes_of(1)
    return Counter(sizes).most_common(1)[0][0] if sizes else 12.0


def load_pdf_meta(path):
    """Describe a stored PDF without rasterizing it.

    Returns::

        {
            "page_image_type": "image/png",
            "page_width":      int,   # image px
            "page_height":     int,   # image px
            "num_pages":       int,
            "pdf_fonts":       [basefont, ...],   # most-used first
            "suggested_scale": int,   # px-per-pt as a percentage
            "suggested_size":  float, # body-text size in points
        }

    Page rasters are served per page by :func:`page_image_bytes`; embedded
    text spans belong to the plugins that read them.
    """
    try:
        doc = fitz.open(str(path))
    except Exception as e:
        print(f"Error opening PDF file: {e}")
        return {"error": str(e)}

    pdf_font_pages = {}   # basefont -> number of pages it appears on
    sample_spans = []

    for page_index in range(len(doc)):
        page = doc[page_index]
        page_num = page_index + 1

        # Declared fonts — a fallback signal that works even on image-only pages.
        try:
            for font_tuple in page.get_fonts(full=False):
                basefont = font_tuple[3] if len(font_tuple) > 3 else ""
                if basefont and basefont not in ("", "unknown"):
                    pdf_font_pages[basefont] = pdf_font_pages.get(basefont, 0) + 1
        except Exception as e:
            print(f"Error collecting declared fonts on page {page_num}: {e}")

        # Body-size sample — the leading pages are plenty.
        if page_index < _SPAN_SAMPLE_PAGES:
            try:
                page_dict = page.get_text("dict")
                for block in page_dict.get("blocks", []):
                    if block.get("type") != 0:
                        continue
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            sample_spans.append({
                                "text": span.get("text", "").strip(),
                                "font": {"size": span.get("size", 0)},
                            })
            except Exception as e:
                print(f"Error sampling text spans on page {page_num}: {e}")

    # The pt->px scale, from the first placed raster (same pixels the viewer gets).
    page_scale_ratio = None
    for page_index in range(len(doc)):
        found = _first_raster(doc, page_index)
        if found:
            _num, _page, _xref, _img_bytes, img_w, _img_h, img_rect = found
            if img_rect is not None and img_rect.width > 0:
                page_scale_ratio = img_w / img_rect.width
            break

    ratio = page_scale_ratio if page_scale_ratio is not None else geo.PT_TO_PX
    num_pages = len(doc)
    doc.close()

    return {
        "page_image_type": "image/png",
        "page_width": geo.PAGE_WIDTH_PX,
        "page_height": geo.PAGE_HEIGHT_PX,
        "num_pages": num_pages,
        "pdf_fonts": sorted(pdf_font_pages, key=pdf_font_pages.get, reverse=True),
        "suggested_scale": round(100 * ratio),
        "suggested_size": _suggested_size(sample_spans),
    }


def load_image_meta(path):
    """Describe a stored raw image (PNG, JPEG, TIFF, …) as a one-page document.

    Same shape as :func:`load_pdf_meta`, minus the typography an image cannot
    declare.
    """
    try:
        with Image.open(str(path)) as img:
            img_w, img_h = img.size
        return {
            "page_image_type": _IMAGE_MIMES.get(path.suffix.lower(), 'image/png'),
            "page_width": img_w,
            "page_height": img_h,
            "num_pages": 1,
            "pdf_fonts": [],
            "suggested_scale": geo.DEFAULT_SCALE,
            "suggested_size": 12.0,
        }
    except Exception as e:
        return {"error": str(e)}


def page_image_bytes(path, page_num, thumb=False):
    """One page's raster from a stored document, on demand.

    Returns ``(bytes, mime)`` or None when the page doesn't exist. For PDFs
    this is the same cropped embedded raster the old inline payload carried —
    identical pixels, so every coordinate consumer stays aligned. Pages with
    no usable embedded raster fall back to a 96-DPI render of the page, which
    lands in the same pixel space by construction (96/72 px per pt).

    ``thumb`` returns a small PNG (180 px wide) for the thumbnail sidebar.
    """
    path = str(path)
    if path.lower().endswith('.pdf'):
        if thumb:
            full = page_image_bytes(path, page_num, thumb=False)
            return (_thumbnail(full[0]), 'image/png') if full else None
        try:
            doc = fitz.open(path)
        except Exception as e:
            print(f"Error opening PDF file: {e}")
            return None
        try:
            if page_num < 1 or page_num > len(doc):
                return None
            found = _first_raster(doc, page_num - 1)
            if found:
                return found[3], 'image/png'
            # No embedded raster (born-digital or unsupported encoding):
            # render the page at the canonical 96 DPI instead of showing nothing.
            pix = doc[page_num - 1].get_pixmap(matrix=fitz.Matrix(geo.PT_TO_PX, geo.PT_TO_PX))
            return pix.tobytes("png"), 'image/png'
        except Exception as e:
            print(f"Error rendering page {page_num}: {e}")
            return None
        finally:
            doc.close()

    # Raw image document — one page, served as stored.
    if page_num != 1:
        return None
    try:
        with open(path, 'rb') as f:
            data = f.read()
    except OSError:
        return None
    if thumb:
        return _thumbnail(data), 'image/png'
    mime = _IMAGE_MIMES.get(path[path.rfind('.'):].lower(), 'image/png')
    return data, mime


def _thumbnail(img_bytes):
    """Downscale a page raster to the sidebar's width; falls back to the input."""
    try:
        with Image.open(BytesIO(img_bytes)) as pil_img:
            if pil_img.mode not in ("RGB", "L"):
                pil_img = pil_img.convert("RGB")
            w, h = pil_img.size
            if w > _THUMB_WIDTH:
                pil_img = pil_img.resize(
                    (_THUMB_WIDTH, max(1, round(h * _THUMB_WIDTH / w))), Image.LANCZOS)
            out = BytesIO()
            pil_img.save(out, format="PNG")
            return out.getvalue()
    except Exception as e:
        print(f"Error building thumbnail: {e}")
        return img_bytes
