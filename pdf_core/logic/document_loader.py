"""Open a document and describe it — the core's only ingestion path.

This module knows how to turn a PDF or a raw image into the payload the viewer
needs to render it: one raster per page, the page geometry, the embedded text
spans, and the document's typography. It deliberately knows nothing about what
any plugin will *do* with that document. Analysis of any kind (redaction
detection, masking, …) belongs to a plugin, which layers itself on top via the
``document:loaded`` hook.

Coordinates follow ``pdf_core.logic.geometry``: everything the frontend touches
is in image pixel space (96 DPI), while font sizes stay in points.
"""

import base64
from collections import Counter
from io import BytesIO

import cv2
import fitz
import numpy as np
from PIL import Image

from . import geometry as geo


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


def iter_page_rasters(doc):
    """Yield ``(page_num, xref, img_bytes, img_w, img_h, img_rect)`` for the first
    usable embedded raster on each page of an open PyMuPDF ``doc``.

    Shared by the loader and by any plugin that needs to analyse the *same*
    pixels the user is looking at — going through here guarantees identical
    cropping, so a plugin's coordinates line up with the rendered page.
    """
    for page_index in range(len(doc)):
        page = doc[page_index]
        page_num = page_index + 1
        try:
            image_list = doc.get_page_images(page_index)
        except Exception as e:
            print(f"Error extracting images on page {page_num}: {e}")
            continue

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

                yield page_num, page, xref, img_bytes, img_w, img_h, img_rect
                break  # one raster per page — the first usable one wins
            except Exception as e:
                print(f"Error processing image xref {xref} on page {page_num}: {e}")


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


def load_pdf(pdf_bytes):
    """Render a PDF and describe it.

    Returns::

        {
            "page_images":     [base64 PNG, one per page],
            "page_image_type": "image/png",
            "page_width":      int,   # image px
            "page_height":     int,   # image px
            "num_pages":       int,
            "spans":           [ {"page", "text", "bbox", "font": {...}} ],
            "pdf_fonts":       [basefont, ...],   # most-used first
            "suggested_scale": int,   # px-per-pt as a percentage
            "suggested_size":  float, # body-text size in points
        }
    """
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        print(f"Error opening PDF stream: {e}")
        return {"error": str(e), "spans": []}

    text_spans = []
    page_images = {}      # page_num -> base64 PNG
    pdf_font_pages = {}   # basefont -> number of pages it appears on
    page_scale_ratio = None  # img_px / page_pt, from the first placed raster

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

        # Embedded text spans — what the embedded-text plugins read.
        try:
            page_dict = page.get_text("dict")
            for block in page_dict.get("blocks", []):
                if block.get("type") != 0:  # text blocks only
                    continue
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        text_spans.append({
                            "page": page_num,
                            "text": span.get("text", "").strip(),
                            "bbox": span.get("bbox"),
                            "font": {
                                "size": span.get("size", 0),
                                "flags": span.get("flags", 0),
                                "matched_font": span.get("font", "unknown"),
                            },
                        })
        except Exception as e:
            print(f"Error extracting text spans on page {page_num}: {e}")

    # Page rasters + the pt->px scale, from the same cropped pixels plugins see.
    for page_num, _page, _xref, img_bytes, img_w, _img_h, img_rect in iter_page_rasters(doc):
        page_images[page_num] = base64.b64encode(img_bytes).decode()
        if page_scale_ratio is None and img_rect is not None and img_rect.width > 0:
            page_scale_ratio = img_w / img_rect.width

    ratio = page_scale_ratio if page_scale_ratio is not None else geo.PT_TO_PX
    num_pages = len(doc)
    doc.close()

    return {
        "page_images": [page_images.get(i + 1) for i in range(num_pages)],
        "page_image_type": "image/png",
        "page_width": geo.PAGE_WIDTH_PX,
        "page_height": geo.PAGE_HEIGHT_PX,
        "num_pages": num_pages,
        "spans": text_spans,
        "pdf_fonts": sorted(pdf_font_pages, key=pdf_font_pages.get, reverse=True),
        "suggested_scale": round(100 * ratio),
        "suggested_size": _suggested_size(text_spans),
    }


def load_image(image_bytes, mime_type="image/png"):
    """Describe a raw image (PNG, JPEG, TIFF, …) as a one-page document.

    Same shape as :func:`load_pdf`, minus the text spans an image cannot have.
    """
    try:
        img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return {"error": "Could not decode image", "spans": []}

        img_h, img_w = img.shape[:2]
        return {
            "page_images": [base64.b64encode(image_bytes).decode()],
            "page_image_type": mime_type,
            "page_width": img_w,
            "page_height": img_h,
            "num_pages": 1,
            "spans": [],
            "pdf_fonts": [],
            "suggested_scale": geo.DEFAULT_SCALE,
            "suggested_size": 12.0,
        }
    except Exception as e:
        return {"error": str(e), "spans": []}
