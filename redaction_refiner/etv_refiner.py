from __future__ import annotations
from typing import Any

from guesser_core.logic import geometry as geo
from guesser_core.logic.refiners.base import DetectedBox, BoxProposal, RedactionRefiner
from guesser_core.logic.refiners.registry import register_refiner
from guesser_core.logic.SurroundingWordWidth import estimate_widths_for_boxes


@register_refiner
class EtvRefiner(RedactionRefiner):
    """
    Refines redaction box edges using embedded PDF text (ETV).
    Wraps SurroundingWordWidth.estimate_widths_for_boxes.

    Expected evidence dict:
        {
            "page":     fitz.Page,
            "img_rect": fitz.Rect,
            "img_w":    int,
            "img_h":    int,
            "img_bytes": bytes,   # optional, enables whitespace detection
        }
    """

    name = "etv"
    # Word-grid / justification-aware edge: trusted above a raw painted-pixel
    # edge so the grid reconstruction wins the edge-by-edge merge.
    _confidence = 0.95
    _max_width_change = 0.25  # reject proposals that change width by more than 25%

    def refine(self, box: DetectedBox, evidence: Any) -> BoxProposal:
        if not evidence:
            return BoxProposal()

        boxes_px = [(box.x, box.y, box.x + box.width, box.y + box.height)]
        results = estimate_widths_for_boxes(
            evidence["page"],
            boxes_px,
            evidence["img_rect"],
            evidence["img_w"],
            evidence["img_h"],
            evidence.get("img_bytes"),
        )
        exp_x1, exp_x2, _ = results[0]

        if exp_x1 is None and exp_x2 is None:
            return BoxProposal()

        temp_x1 = exp_x1 if exp_x1 is not None else box.x
        temp_x2 = exp_x2 if exp_x2 is not None else box.x + box.width

        # Reject if the proposed width change is too large — guards against bad
        # ETV matches. The allowance is floored at one grid cell so a bounded
        # grid snap (<= half a cell) on a small box is never silently dropped.
        if box.width > 0:
            allowed = max(self._max_width_change * box.width, float(geo.GRID_PX))
            if abs((temp_x2 - temp_x1) - box.width) > allowed:
                return BoxProposal()

        return BoxProposal(
            x=float(temp_x1) if exp_x1 is not None else None,
            x2=float(temp_x2) if exp_x2 is not None else None,
            confidence=self._confidence,
            source=self.name,
        )
