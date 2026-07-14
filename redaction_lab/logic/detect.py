"""Redaction detection — the redaction_lab plugin's analysis pass.

The core opens the document and renders it; this module is handed the same bytes
afterwards and answers one question: where are the black bars? It runs on the
rasters produced by ``pdf_core.logic.document_loader.iter_page_rasters`` so the
boxes it reports land in exactly the pixel space the viewer is displaying.

Detected edges are then handed to the refiner pipeline. With no refiner plugin
installed the registry is empty and boxes pass through unrefined.
"""

import cv2
import fitz
import numpy as np

from pdf_core.logic.document_loader import iter_page_rasters

from .BoxDetector import find_redaction_boxes_in_image
from .refiners.base import DetectedBox
from .refiners.registry import RefinerRegistry

_pipeline = None


def _get_pipeline():
    """Build the refiner pipeline from the registry on first use.

    Built lazily so refiners registered by plugins during Django app startup are
    present by the time the first document is processed.
    """
    global _pipeline
    if _pipeline is None:
        _pipeline = RefinerRegistry.build_pipeline()
    return _pipeline


def _as_redaction(page_num, box, pipeline_evidence=None):
    """Refine one raw ``(x1, y1, x2, y2)`` box and shape it for the frontend."""
    bx1, by1, bx2, by2 = box
    detected = DetectedBox(
        page=page_num,
        x=float(bx1), y=float(by1),
        width=float(bx2 - bx1), height=float(by2 - by1),
    )
    if pipeline_evidence is not None:
        detected = _get_pipeline().run(detected, pipeline_evidence)

    return {
        "page": page_num,
        "x": detected.x,
        "y": detected.y,
        "width": detected.width,
        "height": detected.height,
        "area": detected.width * detected.height,
    }


def detect_pdf(pdf_bytes):
    """Find redaction bars in a PDF. Returns ``{"redactions": [...]}``."""
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        print(f"Error opening PDF stream: {e}")
        return {"error": str(e), "redactions": []}

    redactions = []
    for page_num, page, _xref, img_bytes, img_w, img_h, img_rect in iter_page_rasters(doc):
        try:
            boxes, _, _ = find_redaction_boxes_in_image(img_bytes)
            if not boxes or img_rect is None:
                continue

            evidence = {"etv": {
                "page": page,
                "img_rect": img_rect,
                "img_w": img_w,
                "img_h": img_h,
                "img_bytes": img_bytes,
            }}
            redactions.extend(_as_redaction(page_num, b, evidence) for b in boxes)
        except Exception as e:
            print(f"Error detecting redactions on page {page_num}: {e}")

    doc.close()

    # Top-to-bottom, left-to-right.
    redactions.sort(key=lambda b: (b["page"], b["y"], b["x"]))
    return {"redactions": redactions}


def detect_image(image_bytes):
    """Find redaction bars in a raw image. Returns ``{"redactions": [...]}``.

    No refiners run here: they draw on evidence from the surrounding PDF text
    layer, which a bare image does not have.
    """
    try:
        if cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR) is None:
            return {"error": "Could not decode image", "redactions": []}

        boxes, _, _ = find_redaction_boxes_in_image(image_bytes)
        redactions = [_as_redaction(1, b) for b in boxes]
        redactions.sort(key=lambda b: (b["y"], b["x"]))
        return {"redactions": redactions}
    except Exception as e:
        return {"error": str(e), "redactions": []}
