# BoxDetector.py Documentation

The [BoxDetector.py](https://github.com/JaguarM/EpsteinTool/blob/main/pdf_core/logic/BoxDetector.py) script is designed to rapidly process an image...

## Core Function
### [find_redaction_boxes_in_image(image_bytes)](https://github.com/JaguarM/EpsteinTool/blob/main/pdf_core/logic/BoxDetector.py)

This is the primary entry point of the script. It consumes an image (provided as raw byte data) and returns a deduplicated list of detected black rectangular boxes.

**Inputs:**
- `image_bytes` *(bytes)*: Raw byte data of an image, typically read directly from a file (e.g., PNG, JPEG).

**Outputs:**
- `final_boxes` *(list of tuples)*: A list containing tuples of (x, y, width, height) representing the coordinates and dimensions of valid redaction boxes.
- `width` *(int)*: The overall width of the decoded image.
- `height` *(int)*: The overall height of the decoded image.

---

## Algorithm Pipeline

### 1. Image Decoding & Preprocessing
The raw image bytes are decoded using OpenCV into a color format (`cv2.imdecode(..., cv2.IMREAD_COLOR)`). The algorithm conditionally handles images based on their color channels (Grayscale, BGR, or BGRA) and reduces them into a single-channel grayscale matrix.
It then applies a highly strict **pure black threshold**, isolating pixels with a grayscale value of `< 10` effectively converting the image into a boolean mask where `True` represents pure black.

### 2. Run-Length Scanline Extraction
The algorithm scans the boolean mask pixel-row by pixel-row (top to bottom):
- It utilizes `numpy.diff` to efficiently find the boundary edges (starts and ends) of continuous horizontal "runs" of black pixels.
- Runs shorter than `17` pixels wide are instantly discarded, assuming redactions are at least 17px wide. 

### 3. Active Run Tracking (Vertical Box Formation)
The detector tracks the "survivability" of runs moving vertically row by row using an `active_runs` dictionary:
- A previous horizontal run "survives" to the next row if it is mostly contained within a run on the current row (allowing a ±2 pixel horizontal drift).
- Histories and core bounding dimensions (`core_x`, `core_ex`) are tracked for each active shape, allowing it to capture boxes even if their vertical edges are slightly imperfect.
- When an active run can no longer be matched to the current row, it terminates. If its accumulated height is `>= 10` pixels, it advances to edge validation.

---

## Edge-Case Handling & Shape Filtering

To ensure only actual rectangular redaction strips are captured, specific geometric filters are applied:

### Tapered Edge Filter (Hole-Punches)
Because scanned document images might include circular hole-punches that are fully black, they can appear as active runs. To exclude these:
- When an active run terminates, the script analyzes the missing pixels along the top and bottom boundaries.
- If both the top and bottom boundaries are "tapered" (missing up to 30% of pixels in the starting and ending bounding rows respectively), the shape is flagged as a circle/ellipse and discarded.

### Intersecting & Overlapping Boxes (Crosses, Ladders, T-shapes)
When vertical layout bars intersect horizontal redaction bars, they create a single contiguous black object. The algorithm corrects these merged shapes in the [clean_overlapping_boxes()](../../pdf_core/logic/BoxDetector.py) nested function:
- It iterates through all discovered rectangular zones. 
- If a taller vertical box (Box A) intersects a significantly wider horizontal box (Box B), and Box B creates a "T-shape" (ending around the same baseline), it modifies the height of the vertical box so it terminates neatly where the horizontal box begins.
- This ensures intersecting redactions are returned as distinct standard rectangles rather than oddly merged geometric blobs.

## Constraints & Magic Values Summary
- **Minimum Box Width:** `17` pixels.
- **Minimum Box Height:** `10` pixels.
- **Grayscale Threshold:** `< 10` (Extremely dark/pure black).
- **Run horizontal drift tolerance:** `2` pixels left or right.
- **Taper rejection threshold:** Up to `30%` pixel loss at the boundary edges.
