"""Single source of truth for the page geometry and DPI relationship.

Everything in this project lives in one of two coordinate spaces:

* **Image pixel space (96 DPI)** — the source PNG the server extracts and the
  frontend renders. Box ``x/y/w/h``, all widths, the SVG
  viewBox and ``state.pageWidth/Height`` are in these pixels. This is the
  canonical geometry space.
* **PDF point space (72 DPI)** — PyMuPDF text spans/words and font sizes
  (``sizePt``). Font size is the canonical typography unit; it is converted to
  image pixels exactly once, at the SVG render boundary on the frontend.

The bridge between the two is purely the DPI ratio (96/72). Import the named
constants from here instead of re-deriving ``0.75`` / ``816`` / ``1056`` /
``612`` in calling code. The JS mirror of this module is
``text_tool/static/text_tool/geometry.js`` (``window.GEO``).
"""

IMAGE_DPI = 96  # embedded page rasters
POINT_DPI = 72  # PDF point space

PT_TO_PX = IMAGE_DPI / POINT_DPI  # 1.3333… — multiply points to get image px
PX_TO_PT = POINT_DPI / IMAGE_DPI  # 0.75    — multiply image px to get points

# Standard US-Letter page, expressed in each space.
PAGE_WIDTH_PT = 612   # 8.5 in
PAGE_HEIGHT_PT = 792  # 11 in
PAGE_WIDTH_PX = round(PAGE_WIDTH_PT * PT_TO_PX)    # 816
PAGE_HEIGHT_PX = round(PAGE_HEIGHT_PT * PT_TO_PX)  # 1056
PAGE_ASPECT = PAGE_HEIGHT_PX / PAGE_WIDTH_PX       # 1056/816 == 11/8.5

# px-per-pt as a percentage, the unit the /widths backend and frontend exchange
# as ``scale``. Used as the default for both PDFs (fallback) and raw images.
DEFAULT_SCALE = round(100 * PT_TO_PX)  # 133

# SurroundingWordWidth inter-word-gap tuning (previously bare literals).
SPACE_PX_FALLBACK = 5.0    # mean gap to assume when none is measurable
SPACE_PX_CLAMP = (3.0, 8.0)    # clamp applied to the per-line mean gap
GAP_FILTER_RANGE = (3.0, 11.0)  # raw gaps kept before averaging

# Word-grid reconstruction of the left edge (all image px @ 96 DPI).
# Microsoft Word lays indents/tab stops on a 1/4-inch grid measured from the
# left page edge, with a 1-inch default left margin (grid index 4).
GRID_PX = round(IMAGE_DPI * 0.25)   # 24 — 1/4-inch grid step
DEFAULT_MARGIN_PX = IMAGE_DPI       # 96 — default 1-inch left margin
# A justified line stretches its inter-word spaces. We classify a line as
# justified when the per-space width that fills the line exceeds the font's
# natural space width by more than this tolerance.
JUSTIFY_SPACE_TOL_PX = 1.5
