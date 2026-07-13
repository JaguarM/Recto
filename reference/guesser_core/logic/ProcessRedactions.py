import fitz
import numpy as np
import cv2
import base64
import os, sys
from collections import Counter
from io import BytesIO
from PIL import Image

try:
    from .BoxDetector import find_redaction_boxes_in_image
    from .refiners.registry import RefinerRegistry
    from .refiners.base import DetectedBox
    from . import geometry as geo
except ImportError:
    # Standalone execution — add this directory to sys.path
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from BoxDetector import find_redaction_boxes_in_image
    from refiners.registry import RefinerRegistry
    from refiners.base import DetectedBox
    import geometry as geo

_pipeline = None


def _get_pipeline():
    """Build the refiner pipeline from the registry on first use.

    Built lazily so refiners registered by plugins during Django app startup
    are present by the time the first PDF is processed. With no refiner plugin
    installed the registry is empty and boxes pass through unrefined.
    """
    global _pipeline
    if _pipeline is None:
        _pipeline = RefinerRegistry.build_pipeline()
    return _pipeline


def _crop_to_page_ratio(img_bytes):
    """Crop excess bottom pixels so an embedded page image matches the standard
    8.5x11 page ratio (geo.PAGE_ASPECT) the detector and pixel coordinate space
    assume.

    Returns the (possibly re-encoded) PNG bytes; on any failure returns the input
    bytes unchanged. This is the only pixel-altering step between the embedded
    image and the detector, so it is shared by process_pdf and the width debugger
    to guarantee both operate on identical pixels.
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






def process_pdf(pdf_bytes):
    """
    Process a PDF file (bytes) to detect black bars and extract font info.
    Returns:
        {
            "redactions": [ { "page": int, "width": float, "height": float, "area": float, "y": float, "x": float } ],
            "spans": [ { "page": int, "text": str, "font": { "size": float, "flags": int, "font": str } } ]
        }
    """
    redactions = []
    text_spans = []

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        print(f"Error opening PDF stream: {e}")
        return {"error": str(e), "redactions": [], "spans": []}

    page_images = {}      # page_num -> base64 PNG, one per page
    pdf_font_pages = {}   # basefont_name -> number of pages it appears on
    page_scale_ratio = None  # img_px / page_pt, determined from first placed image

    for page_index in range(len(doc)):
        page = doc[page_index]
        page_num = page_index + 1

        # 0. Collect declared fonts for fallback detection (works even on image-only pages)
        try:
            for font_tuple in page.get_fonts(full=False):
                basefont = font_tuple[3] if len(font_tuple) > 3 else ""
                if basefont and basefont not in ("", "unknown"):
                    pdf_font_pages[basefont] = pdf_font_pages.get(basefont, 0) + 1
        except Exception as e:
            print(f"Error collecting declared fonts on page {page_num}: {e}")

        # 1. Extract Text Spans for Font Detection
        try:
            page_dict = page.get_text("dict")
            for block in page_dict.get("blocks", []):
                if block.get("type") == 0:  # text block
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            text_spans.append({
                                "page": page_num,
                                "text": span.get("text", "").strip(),
                                "bbox": span.get("bbox"),
                                "font": {
                                    "size": span.get("size", 0),
                                    "flags": span.get("flags", 0),
                                    "matched_font": span.get("font", "unknown")
                                }
                            })
        except Exception as e:
            print(f"Error extracting text spans on page {page_num}: {e}")

        # 2. Extract images and perform redaction box detection
        try:
            image_list = doc.get_page_images(page_index)
            if not image_list:
                continue
                
            for img_info in image_list:
                xref = img_info[0]
                try:
                    base_image = doc.extract_image(xref)
                    if not base_image: continue
                    
                    image_ext = base_image.get("ext", "").lower()
                    if image_ext not in ('png', 'tiff', 'tif'):
                        continue
                    
                    # Crop excess bottom pixels to the expected 8.5x11 page ratio
                    img_bytes = _crop_to_page_ratio(base_image["image"])

                    # Capture the first valid image on each page
                    if page_num not in page_images:
                        page_images[page_num] = base64.b64encode(img_bytes).decode()

                    boxes, img_w, img_h = find_redaction_boxes_in_image(img_bytes)



                    if not boxes: continue
                    
                    image_rects = page.get_image_rects(xref)
                    if not image_rects: continue
                    img_rect = image_rects[0]

                    if page_scale_ratio is None and img_rect.width > 0:
                        page_scale_ratio = img_w / img_rect.width
                    
                    etv_evidence = {
                        "page": page,
                        "img_rect": img_rect,
                        "img_w": img_w,
                        "img_h": img_h,
                        "img_bytes": img_bytes,
                    }

                    for raw_box in boxes:
                        bx1, by1, bx2, by2 = raw_box
                        detected = DetectedBox(
                            page=page_num,
                            x=float(bx1), y=float(by1),
                            width=float(bx2 - bx1), height=float(by2 - by1),
                        )
                        refined = _get_pipeline().run(detected, {"etv": etv_evidence})

                        w = refined.width
                        h = refined.height
                        redactions.append({
                            "page": page_num,
                            "x": refined.x,
                            "y": refined.y,
                            "width": w,
                            "height": h,
                            "area": w * h,
                        })
                        
                except Exception as e:
                    print(f"Error processing image xref {xref} on page {page_num}: {e}")
        except Exception as e:
            print(f"Error extracting images on page {page_num}: {e}")

    # Sort redactions: Top-to-bottom, Left-to-right
    redactions.sort(key=lambda b: (b["page"], b["y"], b["x"]))

    # suggested_scale: converts font advances (in pt) to image pixel widths.
    ratio = page_scale_ratio if page_scale_ratio is not None else geo.PT_TO_PX
    suggested_scale = round(100 * ratio)

    # suggested_size: mode of body-text span sizes, rounded to nearest 0.5 pt.
    def _body_sizes(spans, min_len):
        return [
            round(s["font"]["size"] * 2) / 2
            for s in spans
            if len(s.get("text", "")) >= min_len and s["font"]["size"] > 0
        ]

    sizes = _body_sizes(text_spans, 20) or _body_sizes(text_spans, 1)
    suggested_size = Counter(sizes).most_common(1)[0][0] if sizes else 12.0

    # Sort declared fonts by number of pages they appear on (most common first)
    pdf_fonts = sorted(pdf_font_pages, key=pdf_font_pages.get, reverse=True)

    num_pages = len(doc)
    doc.close()
    return {
        "redactions": redactions,
        "spans": text_spans,
        "pdf_fonts": pdf_fonts,
        "suggested_scale": suggested_scale,
        "suggested_size": suggested_size,
        "page_images": [page_images.get(i + 1) for i in range(num_pages)],
        "page_image_type": "image/png",
        "page_width": geo.PAGE_WIDTH_PX,
        "page_height": geo.PAGE_HEIGHT_PX,
        "num_pages": num_pages,
    }

def process_image(image_bytes, mime_type="image/png"):
    """
    Process a raw image file (PNG, JPEG, TIFF, …) to detect redaction boxes.
    Returns the same structure as process_pdf but without text span data.
    """
    try:
        img_array = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
        if img is None:
            return {"error": "Could not decode image", "redactions": [], "spans": []}

        img_h, img_w = img.shape[:2]

        boxes, _, _ = find_redaction_boxes_in_image(image_bytes)

        redactions = []
        for box in boxes:
            bx1, by1, bx2, by2 = box
            w = float(bx2 - bx1)
            h = float(by2 - by1)
            redactions.append({
                "page": 1,
                "x": float(bx1),
                "y": float(by1),
                "width": w,
                "height": h,
                "area": w * h,
            })
        redactions.sort(key=lambda b: (b["y"], b["x"]))

        page_image_b64 = base64.b64encode(image_bytes).decode()

        return {
            "redactions": redactions,
            "spans": [],
            "suggested_scale": geo.DEFAULT_SCALE,
            "page_images": [page_image_b64],
            "page_image_type": mime_type,
            "page_width": img_w,
            "page_height": img_h,
            "num_pages": 1,
        }
    except Exception as e:
        return {"error": str(e), "redactions": [], "spans": []}
