import numpy as np
import cv2
from io import BytesIO
from PIL import Image
import fitz


def get_grayscale_image_bytes(doc, page_index, image_index=0):
    """
    Extracts the base image natively as a grayscale PNG, bypassing ICC profile
    issues that occur with PIL's loading of raw embedded JPEGs, and bypassing
    PDF page scaling offsets.
    """
    try:
        image_list = doc.get_page_images(page_index)
        if not image_list or image_index >= len(image_list):
            return None
        xref = image_list[image_index][0]
        pix = fitz.Pixmap(doc, xref)

        # Force strict 8-bit grayscale to avoid any ICC color shifts later
        if pix.n > 1 or (pix.colorspace and pix.colorspace.name != fitz.csGRAY.name):
            try:
                gray_pix = fitz.Pixmap(fitz.csGRAY, pix)
                pix = gray_pix
            except Exception:
                pass  # fallback if csGRAY conversion fails

        image_bytes = pix.tobytes("png")
        return image_bytes
    except Exception as e:
        print(f"Error extracting image {image_index} from page {page_index}: {e}")
    return None


def _dilate(m):
    """Expand a boolean mask by 1 pixel in all 4 directions."""
    d = m.copy()
    d[1:] |= m[:-1]
    d[:-1] |= m[1:]
    d[:, 1:] |= m[:, :-1]
    d[:, :-1] |= m[:, 1:]
    return d


def _remove_circles(rendered, black_mask):
    blurred = cv2.GaussianBlur(rendered, (9, 9), 2)
    circles = cv2.HoughCircles(
        blurred,
        cv2.HOUGH_GRADIENT,
        dp=1,
        minDist=30,
        param1=100,
        param2=30,
        minRadius=8,
        maxRadius=20,
    )
    if circles is None:
        return black_mask

    reject = np.zeros(rendered.shape, dtype=np.uint8)
    for cx, cy, r in np.round(circles[0]).astype(int):
        cv2.circle(reject, (cx, cy), r + 2, 1, thickness=cv2.FILLED)
    return black_mask & (reject == 0)


def _filter_components(black_mask):
    img = black_mask.astype(np.uint8) * 255

    # Remove thin text protrusions from redaction edges
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    img = cv2.morphologyEx(img, cv2.MORPH_OPEN, kernel)

    contours, _ = cv2.findContours(img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    result = np.zeros_like(img)
    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)
        if w < 17 or h < 10:
            continue

        # Reject thin strokes: area/perimeter ≈ thickness/2 for thin shapes;
        # solid redaction blocks have a much higher ratio.
        area = cv2.contourArea(cnt)
        perimeter = cv2.arcLength(cnt, True)
        if perimeter > 0 and area / perimeter < 2:
            continue

        cv2.drawContours(result, [cnt], -1, 255, thickness=cv2.FILLED)

    return result.astype(bool)


def _apply_edge_lines(m, border1, border2, outer1, black_mask, rendered):
    h_border1 = border1 & (
        np.roll(black_mask, 1, axis=0) | np.roll(black_mask, -1, axis=0)
    )
    v_border1 = border1 & ~h_border1

    h_border2 = border2 & (
        np.roll(outer1, 1, axis=0) | np.roll(outer1, -1, axis=0)
    )
    v_border2 = border2 & ~h_border2

    for h_border in (h_border1, h_border2):
        for y in range(h_border.shape[0]):
            row = h_border[y]
            if not np.any(row):
                continue
            padded = np.concatenate(([False], row, [False]))
            diff = np.diff(padded.astype(np.int8))
            for sx, ex in zip(np.where(diff == 1)[0], np.where(diff == -1)[0]):
                val = 255 - int(rendered[y, sx:ex].max())
                m[y, sx:ex] = val

    for v_border in (v_border1, v_border2):
        for x in range(v_border.shape[1]):
            col = v_border[:, x]
            if not np.any(col):
                continue
            padded = np.concatenate(([False], col, [False]))
            diff = np.diff(padded.astype(np.int8))
            for sy, ey in zip(np.where(diff == 1)[0], np.where(diff == -1)[0]):
                val = 255 - int(rendered[sy:ey, x].max())
                m[sy:ey, x] = val


def build_mask_array(rendered):
    """
    Given a grayscale uint8 numpy array, returns a uint8
    mask: 255 = redacted interior, 0 = clear, mid-gray = border indicator.
    Returns None if no redactions are found after filtering.
    """
    black_mask = rendered <= 0
    black_mask = _remove_circles(rendered, black_mask)
    black_mask = _filter_components(black_mask)
    if not np.any(black_mask):
        return None

    outer1 = _dilate(black_mask)
    border1 = outer1 & ~black_mask
    border2 = _dilate(outer1) & ~outer1

    m = np.zeros(rendered.shape, dtype=np.uint8)
    m[black_mask] = 255
    _apply_edge_lines(m, border1, border2, outer1, black_mask, rendered)
    return m
