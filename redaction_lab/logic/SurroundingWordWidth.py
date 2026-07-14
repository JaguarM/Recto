from collections import Counter

import numpy as np
import cv2

from pdf_core.logic import geometry as geo

try:
    # HarfBuzz-shaped widths, used to reconstruct the Word grid: the natural
    # space width and the stretched per-space width of a justified line.
    from text_tool.logic.width_calculator import (
        get_text_widths,
        get_justified_space_width,
    )
except Exception:  # standalone / shaping unavailable -> fall back to pixel gaps
    get_text_widths = None
    get_justified_space_width = None


# PDF base-font name (often a subset like "ABCDEE+TimesNewRomanPSMT") mapped to a
# TTF that ships in assets/fonts/. Used only to size the natural/justified space;
# default to a serif (the sample corpus is Times) when nothing matches.
_FONT_MAP = (
    ("times", "times.ttf"), ("roman", "times.ttf"), ("serif", "times.ttf"),
    ("arial", "Arial.ttf"), ("helvetica", "Arial.ttf"),
    ("courier", "Courier_New.ttf"), ("mono", "Courier_New.ttf"),
    ("verdana", "Verdana.ttf"),
    ("calibri", "calibri.ttf"),
    ("segoe", "segoe_ui.ttf"),
)


def _map_font(pdf_font_name):
    name = (pdf_font_name or "").lower()
    for key, ttf in _FONT_MAP:
        if key in name:
            return ttf
    return "times.ttf"


def _collect_spans(page):
    """Flatten the page's text spans to (bbox, font_name, size_pt) tuples."""
    spans = []
    try:
        page_dict = page.get_text("dict")
    except Exception:
        return spans
    for block in page_dict.get("blocks", []):
        if block.get("type") != 0:  # text blocks only
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                bb = span.get("bbox")
                size = span.get("size", 0)
                if bb and size and size > 0:
                    spans.append((bb, span.get("font", ""), float(size)))
    return spans


def _line_font(spans, line_words):
    """Pick the dominant (font_ttf, size_pt) for the spans covering a line."""
    if not line_words:
        return ("times.ttf", 12.0)
    y0 = min(w[1] for w in line_words)
    y1 = max(w[3] for w in line_words)
    cands = [(font, size) for bb, font, size in spans
             if y0 - 2 <= (bb[1] + bb[3]) / 2.0 <= y1 + 2]
    if not cands:
        return ("times.ttf", 12.0)
    size = Counter(round(s * 2) / 2 for _, s in cands).most_common(1)[0][0]
    font = next((f for f, s in cands if round(s * 2) / 2 == size), cands[0][0])
    return (_map_font(font), float(size))


def _line_space_widths(line_words, block_w_px, font_ttf, size_pt, scale_factor):
    """
    Reconstruct the inter-word spacing the line was set with, in image px.

    Returns ``(natural_space_px, justified_space_px)``. ``natural_space_px`` is
    the font's shaped space advance; ``justified_space_px`` is the per-space
    width that makes the full line text (including any word hidden under a box —
    the text layer survives the paint) fill its ETV extent ``block_w_px``. Either
    may be ``None`` when shaping is unavailable or not applicable (e.g. the final,
    un-stretched line of a justified paragraph solves back to ~the natural space).
    """
    if get_text_widths is None:
        return (None, None)
    nat = get_text_widths([" "], font_name=font_ttf, font_size=size_pt,
                          scale_factor=scale_factor)
    natural_space = nat[0].get("width") if nat else None
    if not natural_space or natural_space <= 0:
        natural_space = None

    justified_space = None
    if get_justified_space_width is not None and block_w_px and block_w_px > 0:
        line_text = " ".join((w[4] or "") for w in line_words).strip()
        if line_text:
            justified_space = get_justified_space_width(
                line_text, block_w_px, font_name=font_ttf, font_size=size_pt,
                scale_factor=scale_factor)
    return (natural_space, justified_space)


def _is_glyph_col(col, dark_thresh=160, min_dark_px=2, max_dark_frac=0.8):
    """
    True if a pixel column looks like part of a letter rather than the box's own
    edge or blank paper.

    A glyph darkens at least `min_dark_px` rows but fewer than `max_dark_frac` of
    the column. Redaction boxes are painted taller than the text they hide, so
    the box's anti-aliased edge runs dark down the *whole* column, whereas a
    letter — or the sliver of one poking past the paint — only darkens the text
    rows in the middle. Flat background has no dark rows at all. This height test
    separates a poking glyph from the box edge far more reliably than pixel
    darkness alone (the box's own AA can be as dark as ink).
    """
    n_dark = int(np.count_nonzero(col < dark_thresh))
    return min_dark_px <= n_dark < max_dark_frac * len(col)


def _subpixel_glyph_edge(img, edge, direction, y0, y1):
    """
    Place a validated poking-glyph edge at the sub-pixel position where the
    column's darkest row crosses 50% ink (gray 127.5), interpolating the row-min
    profile across the outermost two columns of the absorbed poke.

    BoxDetector and the integer walk in _content_edge land on whole columns, but
    a faint anti-aliased poke covers a column only fractionally (e.g. the "S" of
    a hidden name reaches col 233 at ~40% ink, full ink only at col 234). Snapping
    such an edge to the integer column throws away up to a pixel of the name's
    true extent. This refines just that last edge; it is only ever called on a
    column the glyph test already accepted, so the box's own full-height AA edge
    (rejected by _is_glyph_col) is never refined here. Returns a float within ~1px
    of `edge`, or `edge` unchanged when the local profile is flat/unusable.
    """
    THRESH = 127.5
    h, w = img.shape[:2]

    def cmin(c):
        return float(img[y0:y1, c].min()) if 0 <= c < w else 255.0

    if direction < 0:  # left edge: `edge` is the outermost glyph column
        g = int(round(edge))
        m_g, m_in = cmin(g), cmin(g + 1)          # paper-side g, ink-side g+1
        if m_g >= THRESH > m_in:                   # 50% crossing lies in [g, g+1]
            return g + (m_g - THRESH) / (m_g - m_in)
        m_out = cmin(g - 1)
        if m_out >= THRESH > m_g:                   # poke fuller than 50% -> crossing in [g-1, g]
            return (g - 1) + (m_out - THRESH) / (m_out - m_g)
        return float(g)
    else:              # right edge: `edge` is one past the last glyph column
        g = int(round(edge)) - 1
        m_g, m_in = cmin(g), cmin(g - 1)          # paper-side g, ink-side g-1
        if m_g >= THRESH > m_in:
            return (g + 1) - (m_g - THRESH) / (m_g - m_in)
        m_out = cmin(g + 1)
        if m_out >= THRESH > m_g:
            return (g + 1) + (m_out - THRESH) / (m_out - m_g)
        return float(g + 1)


def _box_aa_edge(img, ink_edge_px, direction, y0, y1, bound_px):
    """
    Extend a box edge that BoxDetector left on its pure-black column across the
    box's own anti-aliased fringe, returning the sub-pixel ink-coverage position.

    BoxDetector thresholds at pure black (`< 10`), so a box whose painted edge is
    anti-aliased is reported a pixel narrow: the greyed fringe column (e.g. box 2's
    left col at ~66/255, full height) is dropped. When no glyph pokes past the
    paint the box edge is the best proxy for the hidden name edge, so leaving it a
    pixel short biases the width low. This recovers that fringe: it fires only on a
    single full-height grey column with paper beyond it (the box's AA edge), never
    on a partial-height glyph, and the placement is bounded outward by `bound_px`
    (and, upstream, clamped against neighbour∓space), so it cannot run wide.

    Returns the refined edge, or `ink_edge_px` unchanged when there is no fringe.
    """
    if img is None:
        return float(ink_edge_px)
    h, w = img.shape[:2]
    e = int(round(ink_edge_px))
    # left edge is inclusive (fringe sits at e-1); right edge is exclusive (fringe at e)
    aa_col = e - 1 if direction < 0 else e
    out_col = aa_col - 1 if direction < 0 else aa_col + 1
    if not (0 <= aa_col < w and 0 <= out_col < w):
        return float(ink_edge_px)
    if direction < 0 and aa_col < int(bound_px):
        return float(ink_edge_px)
    if direction > 0 and aa_col >= int(bound_px):
        return float(ink_edge_px)

    col = img[y0:y1, aa_col]
    dark_frac = np.count_nonzero(col < 200) / len(col)
    mean_aa = float(col.mean())
    mean_out = float(img[y0:y1, out_col].mean())
    # Box AA fringe = covered the whole height (like the box, unlike a glyph),
    # greyer than pure black, with paper just beyond it.
    if dark_frac < 0.8 or mean_aa < 16.0 or mean_out < 200.0:
        return float(ink_edge_px)

    coverage = (255.0 - mean_aa) / 255.0          # ink fraction of the fringe column
    return ink_edge_px - coverage if direction < 0 else ink_edge_px + coverage


def _content_edge(img, ink_edge_px, direction, y0, y1, bound_px):
    """
    Walk outward from a box's ink edge through contiguous glyph ink and return
    the refined edge (in image px).

    BoxDetector reports the *pure-black* extent of the redaction, but the true
    visual extent is sometimes a hair wider: a glyph of the hidden text can poke
    past the paint (e.g. the left bowl of an "S" sticking out of the box). This
    walk, starting just outside the ink edge, absorbs every column that looks
    like such a poking glyph (including its faint anti-aliased fringe) and stops
    at the first column that does not — so a poking letter is kept whole, while
    the empty inter-word gap (and any neighbouring word beyond it) is left out.

    direction: -1 refines the left edge (scan leftwards, returns the new x0);
               +1 refines the right edge (scan rightwards, returns the new x1).
    bound_px:  near edge of the neighbouring word; the scan never crosses it, so
               a box that physically touches the next word can't swallow it.
    """
    if img is None:
        return float(ink_edge_px)
    h, w = img.shape[:2]
    y0 = max(0, int(y0))
    y1 = min(h, int(y1))
    if y1 - y0 < 2:
        return float(ink_edge_px)

    edge = float(ink_edge_px)
    x = int(round(ink_edge_px))
    while True:
        col_x = x - 1 if direction < 0 else x
        if col_x < 0 or col_x >= w:
            break
        if direction < 0 and col_x < int(bound_px):
            break
        if direction > 0 and col_x >= int(bound_px):
            break

        if not _is_glyph_col(img[y0:y1, col_x]):
            break  # box-edge anti-alias or background whitespace -> stop

        if direction < 0:
            edge = float(col_x)
            x = col_x
        else:
            edge = float(col_x + 1)
            x = col_x + 1

    # If a glyph poke was actually absorbed (the edge moved past the ink), refine
    # that outer edge to its sub-pixel 50%-ink crossing. Otherwise the walk stopped
    # on the box's own edge -> recover the anti-aliased fringe BoxDetector trimmed.
    if edge != float(ink_edge_px):
        edge = _subpixel_glyph_edge(img, edge, direction, y0, y1)
    else:
        edge = _box_aa_edge(img, ink_edge_px, direction, y0, y1, bound_px)
    return edge


def _next_word_edge(img, start_px, direction, y0, y1, bound_px):
    """
    Scan outward from a box's content edge, across the inter-word whitespace, and
    return the near ink edge (px) of the next word's glyphs — or None if no word
    is reached before bound_px.

    This is found from PIXELS on purpose: when a redaction covers the first
    letter of the following word, PyMuPDF's text layer reports only the visible
    fragment ("nd" for "and") sitting where the fragment starts, not where the
    word visually begins. Locating the word by its ink avoids that error. The
    box's own full-height anti-aliased edge is skipped by the same glyph test, so
    a box flush against the next word is still measured.
    """
    if img is None:
        return None
    h, w = img.shape[:2]
    y0 = max(0, int(y0))
    y1 = min(h, int(y1))
    if y1 - y0 < 2:
        return None

    col_x = int(round(start_px)) if direction > 0 else int(round(start_px)) - 1
    while 0 <= col_x < w:
        if direction > 0 and col_x >= int(bound_px):
            return None
        if direction < 0 and col_x < int(bound_px):
            return None
        if _is_glyph_col(img[y0:y1, col_x]):
            return float(col_x + 1) if direction < 0 else float(col_x)
        col_x += direction
    return None


def estimate_widths_for_boxes(page, boxes, img_rect, img_w, img_h, base_image_bytes=None, debug_out=None):
    """
    Measures width of text based on surrounding words.
    Returns a list of expected pixel widths corresponding to the input boxes.
    If an expected width cannot be calculated, the list contains None at that index.

    debug_out: optional list. When provided, one dict of per-box intermediates
    (chosen line, neighbour words, space_px, content edges, next-word-by-pixel
    edges, expected edges) is appended for each input box. Default None keeps
    production behaviour and cost unchanged; only the width debugger passes it.
    """
    img = None
    if base_image_bytes is not None:
        img_array = np.frombuffer(base_image_bytes, np.uint8)
        img = cv2.imdecode(img_array, cv2.IMREAD_GRAYSCALE)
    words_pts = page.get_text("words")
    spans = _collect_spans(page)
    px_to_pts_x = img_rect.width / img_w
    px_to_pts_y = img_rect.height / img_h
    pts_to_px_x = 1.0 / px_to_pts_x
    pts_to_px_y = 1.0 / px_to_pts_y

    boxes_pts = []
    for b in boxes:
        boxes_pts.append({
            'x0': img_rect.x0 + b[0] * px_to_pts_x,
            'y0': img_rect.y0 + b[1] * px_to_pts_y,
            'x1': img_rect.x0 + b[2] * px_to_pts_x,
            'y1': img_rect.y0 + b[3] * px_to_pts_y,
            'bx1': b[0], 'by1': b[1], 'bx2': b[2], 'by2': b[3]
        })

    expected_widths = []

    for b_dict in boxes_pts:
        bx1, by1, bx2, by2 = b_dict['bx1'], b_dict['by1'], b_dict['bx2'], b_dict['by2']
        bx_pts, by_pts = b_dict['x0'], b_dict['y0']
        bx1_pts, by1_pts = b_dict['x1'], b_dict['y1']

        buckets = []
        for w in words_pts:
            wy0, wy1 = w[1], w[3]
            height_word = wy1 - wy0
            if height_word <= 0: continue

            overlap_y = max(0, min(by1_pts, wy1) - max(by_pts, wy0))
            if overlap_y / height_word >= 0.5:
                wy_mid = (wy0 + wy1) / 2
                matched_bucket = None
                for bucket in buckets:
                    if abs(bucket['mid'] - wy_mid) < 5:
                        matched_bucket = bucket
                        break
                if matched_bucket:
                    matched_bucket['words'].append(w)
                    matched_bucket['mid'] = sum((ww[1]+ww[3])/2 for ww in matched_bucket['words']) / len(matched_bucket['words'])
                else:
                    buckets.append({'mid': wy_mid, 'words': [w]})

        best_match = None
        best_dist_sum = float('inf')
        best_matches_count = 0
        best_line_words = []

        for bucket in buckets:
            line_words = bucket['words']
            line_words.sort(key=lambda w: w[0])

            word_before = None
            dist_before = float('inf')
            for w in line_words:
                if w[2] <= bx_pts + 5:
                    obstructed = False
                    for ob in boxes_pts:
                        if ob == b_dict: continue
                        y_overlap = max(0, min(by1_pts, ob['y1']) - max(by_pts, ob['y0']))
                        if y_overlap > 0:
                            if ob['x1'] > w[2] and ob['x0'] < bx_pts:
                                obstructed = True
                                break
                    if not obstructed:
                        dist = bx_pts - w[2]
                        if dist < dist_before:
                            dist_before = dist
                            word_before = w

            word_after = None
            dist_after = float('inf')
            for w in line_words:
                if w[0] >= bx1_pts - 5:
                    obstructed = False
                    for ob in boxes_pts:
                        if ob == b_dict: continue
                        y_overlap = max(0, min(by1_pts, ob['y1']) - max(by_pts, ob['y0']))
                        if y_overlap > 0:
                            if ob['x1'] > bx1_pts and ob['x0'] < w[0]:
                                obstructed = True
                                break
                    if not obstructed:
                        dist = w[0] - bx1_pts
                        if dist < dist_after:
                            dist_after = dist
                            word_after = w

            matches_count = (1 if word_before else 0) + (1 if word_after else 0)
            if matches_count > 0:
                dist_sum = (dist_before if word_before else 0) + (dist_after if word_after else 0)
                if matches_count > best_matches_count or (matches_count == best_matches_count and dist_sum < best_dist_sum):
                    best_matches_count = matches_count
                    best_dist_sum = dist_sum
                    best_match = (word_before, word_after)
                    best_line_words = line_words

        if best_match:
            word_before, word_after = best_match

            # Near edge of each neighbouring (non-redacted) word in image px, or
            # the page border when there is none on that side.
            left_bound = (word_before[2] - img_rect.x0) * pts_to_px_x if word_before else 0.0
            right_bound = (word_after[0] - img_rect.x0) * pts_to_px_x if word_after else float(img_w)

            # Average inter-word space on this line, in image px (clamped to a
            # sane range so a sparse line can't produce a wild value). Used for
            # the right edge and as a fallback when shaping is unavailable.
            gaps = [(best_line_words[i + 1][0] - best_line_words[i][2]) * pts_to_px_x
                    for i in range(len(best_line_words) - 1)]
            gap_lo, gap_hi = geo.GAP_FILTER_RANGE
            gaps = [g for g in gaps if gap_lo <= g <= gap_hi]
            # Real inter-word gap on this line (mean of the surviving, sane gaps).
            # Gaps that span the box are far outside GAP_FILTER_RANGE and are
            # dropped, so this reflects genuine adjacent visible-word spacing.
            measured_gap = sum(gaps) / len(gaps) if gaps else None
            space_px = measured_gap if measured_gap is not None else geo.SPACE_PX_FALLBACK
            space_px = min(max(space_px, geo.SPACE_PX_CLAMP[0]), geo.SPACE_PX_CLAMP[1])

            # Reconstruct the Word grid for the LEFT edge. Shape the line in its
            # own font for the natural space width; a justified line stretches
            # that space, so the box should start one *stretched* space after the
            # previous word. Justification is judged from the measured pixel gap,
            # not the fill-width solve: under a redaction the text layer is often
            # fragmented, which makes the solve explode, so it is debug-only here.
            font_ttf, size_pt = _line_font(spans, best_line_words)
            block_w_px = ((best_line_words[-1][2] - best_line_words[0][0]) * pts_to_px_x
                          if best_line_words else None)

            # The line's first word is the paragraph origin and in Word always
            # sits on a 1/4-inch grid line. Snap it to the grid and carry that
            # correction along the line, so a box with a word in front is placed
            # relative to the grid-aligned origin rather than the drifted render.
            first_word_x0_px = (best_line_words[0][0] - img_rect.x0) * pts_to_px_x
            grid_origin_px = round(first_word_x0_px / geo.GRID_PX) * geo.GRID_PX
            grid_offset = grid_origin_px - first_word_x0_px
            natural_space, justified_space = _line_space_widths(
                best_line_words, block_w_px, font_ttf, size_pt, pts_to_px_x)
            is_justified = (measured_gap is not None and natural_space is not None
                            and measured_gap > natural_space + geo.JUSTIFY_SPACE_TOL_PX)
            if is_justified:
                word_space_px = measured_gap        # stretched space (bounded by GAP_FILTER_RANGE)
            elif natural_space is not None:
                word_space_px = natural_space        # natural single space after the word
            else:
                word_space_px = space_px             # shaping unavailable -> pixel-gap fallback

            # Inset the vertical band so the box's own top/bottom corners are not
            # mistaken for edge content.
            y0_scan = int(by1) + 2
            y1_scan = int(by2) - 2

            # Pixel extent of the box: its ink plus any glyph of the hidden text
            # that pokes past the paint (e.g. the bowl of an "S"), stopping at the
            # inter-word whitespace.
            content_x1 = _content_edge(img, bx1, -1, y0_scan, y1_scan, left_bound)
            content_x2 = _content_edge(img, bx2, +1, y0_scan, y1_scan, right_bound)

            # Where the box was painted over the inter-word space, its edge sits
            # past the hidden text inside that gap. We can't see the covered
            # letters, but we can locate the next word by its pixels and back off
            # one space to reconstruct the true edge. The redaction edge is the
            # innermost of the painted extent and "neighbour minus a space", so a
            # poking glyph still wins (it is real ink) while a box that overran
            # the gap is pulled back.
            nbr_l = _next_word_edge(img, content_x1, -1, y0_scan, y1_scan,
                                    (left_bound - 6.0) if word_before else (content_x1 - 14.0))
            nbr_r = _next_word_edge(img, content_x2, +1, y0_scan, y1_scan,
                                    (right_bound + 6.0) if word_after else (content_x2 + 14.0))

            # Left edge, Word-grid aware:
            #  * No word in front -> the box is the first thing on the line, so
            #    its true start is a 1/4-inch grid line measured from the page
            #    left edge (Word indents/tab stops). The painted ink can't be
            #    trusted there, but the grid always matches the source, so snap
            #    to the nearest grid line.
            #  * Word in front -> place the start one (natural or stretched)
            #    space after that word's far edge, then re-anchor to the grid by
            #    the line's first-word offset. max() never lets the result sit
            #    inside the painted ink (keeps a poking glyph that is real ink).
            grid_x1 = round(content_x1 / geo.GRID_PX) * geo.GRID_PX
            if word_before is None:
                expected_x1_px = float(grid_x1)
            else:
                expected_x1_px = content_x1
                if nbr_l is not None:
                    expected_x1_px = max(content_x1, nbr_l + word_space_px + grid_offset)

            expected_x2_px = content_x2
            if nbr_r is not None:
                expected_x2_px = min(content_x2, nbr_r - space_px)

            expected_height_px = None
            if best_line_words:
                heights_pts = [w[3] - w[1] for w in best_line_words if w[3] - w[1] > 0]
                if heights_pts:
                    expected_height_px = (sum(heights_pts) / len(heights_pts)) * pts_to_px_y

            expected_widths.append((expected_x1_px, expected_x2_px, expected_height_px))

            if debug_out is not None:
                debug_out.append({
                    'raw_ink': (float(bx1), float(bx2)),
                    'line_words': [w[4] for w in best_line_words],
                    'word_before': word_before[4] if word_before else None,
                    'word_after': word_after[4] if word_after else None,
                    'left_bound': left_bound,        # word_before near edge (text layer), px
                    'right_bound': right_bound,       # word_after near edge (text layer), px
                    'space_px': space_px,
                    'gaps': gaps,
                    'y_scan': (y0_scan, y1_scan),
                    'content_x1': content_x1,         # ink + poking glyph, left
                    'content_x2': content_x2,         # ink + poking glyph, right
                    'nbr_l': nbr_l,                   # next word near edge by pixels, left
                    'nbr_r': nbr_r,                   # next word near edge by pixels, right
                    'expected_x1': expected_x1_px,
                    'expected_x2': expected_x2_px,
                    # Word-grid reconstruction (left edge):
                    'font': font_ttf,
                    'size_pt': size_pt,
                    'block_w_px': block_w_px,         # line ETV extent (first.x0 -> last.x1)
                    'measured_gap': measured_gap,     # mean real inter-word gap, px
                    'natural_space': natural_space,   # shaped space advance, px
                    'justified_space': justified_space,  # solved fill-width (debug only; see note), px
                    'is_justified': is_justified,
                    'word_space_px': word_space_px,   # space actually used for the left edge
                    'grid_x1': float(grid_x1),        # nearest 1/4-inch grid line to content_x1
                    'first_word_x0_px': first_word_x0_px,  # line's first-word left edge, px
                    'grid_origin_px': float(grid_origin_px),  # that edge snapped to the grid
                    'grid_offset': grid_offset,       # correction carried along the line
                    'word_before_present': word_before is not None,
                })
        else:
            # No neighbouring words on the box's line, so we can't reconstruct
            # the inter-word spacing. The box is isolated, which in the Word
            # source means it began on a 1/4-inch grid line. Snap its painted
            # left edge to the nearest grid line (origin = page left edge) and
            # abstain on the right edge — the same treatment a no-word-before
            # box gets when a line context exists.
            y0_scan = int(by1) + 2
            y1_scan = int(by2) - 2
            content_x1 = _content_edge(img, bx1, -1, y0_scan, y1_scan, 0.0)
            grid_x1 = round(content_x1 / geo.GRID_PX) * geo.GRID_PX
            expected_widths.append((float(grid_x1), None, None))
            if debug_out is not None:
                debug_out.append({
                    'raw_ink': (float(b_dict['bx1']), float(b_dict['bx2'])),
                    'reason': 'no neighbouring words; isolated box, left edge grid-snapped',
                    'content_x1': content_x1,
                    'grid_x1': float(grid_x1),
                    'expected_x1': float(grid_x1),
                    'word_before_present': False,
                })

    return expected_widths
