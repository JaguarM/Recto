import os
import numpy as np
from io import BytesIO
from PIL import Image
import base64
import fitz

from .masking import get_grayscale_image_bytes, build_mask_array

# CLI mode input: defaults to the app's startup PDF (the one in assets/pdfs/);
# pass a path as the first argument to process another file.

PAGE_W, PAGE_H = 816, 1056


def create_redaction_masks(pdf_path):
    print(f"\n--- Creating Redaction Masks for {os.path.basename(pdf_path)} ---")
    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        print(f"Error opening PDF: {e}")
        return

    base = os.path.splitext(pdf_path)[0]
    found_any = False

    for page_index in range(len(doc)):
        page_num = page_index + 1

        img_bytes = get_grayscale_image_bytes(doc, page_index)
        if not img_bytes:
            continue

        with Image.open(BytesIO(img_bytes)) as pil_img:
            rendered = np.array(pil_img.convert("L"))

        mask = build_mask_array(rendered)
        if mask is None:
            continue

        out_path = f"{base}_mask_p{page_num}.png"
        Image.fromarray(mask, "L").save(out_path)
        print(f"Saved mask for page {page_num} → {out_path}")
        found_any = True

    if not found_any:
        print("No redactions found.")

    doc.close()


def generate_mask_for_page(pdf_source, page_num):
    """
    Generates an 8-bit grayscale PNG mask for redactions on the given page.
    Returns the mask PNG bytes. 0 = unredacted (black), 255 = redacted (white).

    ``pdf_source`` is a filesystem path (str) or raw PDF bytes — the path form
    is what the per-page mask endpoint uses, so a huge stored document is
    never read into memory whole.
    """
    try:
        if isinstance(pdf_source, (bytes, bytearray)):
            doc = fitz.open(stream=pdf_source, filetype="pdf")
        else:
            doc = fitz.open(str(pdf_source))
    except Exception as e:
        print(f"Error opening PDF: {e}")
        return None

    if page_num < 1 or page_num > len(doc):
        doc.close()
        return None

    img_bytes = get_grayscale_image_bytes(doc, page_num - 1)

    if not img_bytes:
        doc.close()
        return None

    with Image.open(BytesIO(img_bytes)) as pil_img:
        rendered = np.array(pil_img.convert("L"))

    mask = build_mask_array(rendered)

    doc.close()

    if mask is None:
        return None

    out_io = BytesIO()
    Image.fromarray(mask, "L").save(out_io, format="PNG")
    return out_io.getvalue()


def generate_all_masks(pdf_bytes):
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        print(f"Error opening PDF: {e}")
        return []

    masks = []
    for page_index in range(len(doc)):
        img_bytes = get_grayscale_image_bytes(doc, page_index)
        if not img_bytes:
            masks.append(None)
            continue

        mask_b64 = generate_mask_from_image(img_bytes)
        masks.append(mask_b64)

    doc.close()
    return masks


def generate_mask_from_image(img_bytes):
    """Generate a base64-encoded grayscale mask PNG from an extracted page image.
    Returns base64 string or None if no redactions found."""
    try:
        with Image.open(BytesIO(img_bytes)) as pil_img:
            rendered = np.array(pil_img.convert("L"))

        mask = build_mask_array(rendered)
        if mask is None:
            return None

        out_io = BytesIO()
        Image.fromarray(mask, "L").save(out_io, format="PNG")
        return base64.b64encode(out_io.getvalue()).decode()
    except Exception as e:
        print(f"Error generating mask: {e}")
        return None


if __name__ == "__main__":
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
    from pdf_core.logic.default_document import find_default_document

    source = sys.argv[1] if len(sys.argv) > 1 else find_default_document()
    if source and os.path.exists(source):
        create_redaction_masks(str(source))
        print("Processing finished.")
    else:
        print("Error: no input PDF. Put one in assets/pdfs/ or pass a path as the first argument.")
