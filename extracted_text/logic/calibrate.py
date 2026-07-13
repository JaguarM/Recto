"""
calibrate.py — Glyph position calibration from OCR ground truth

Pipeline:
  Step 0. FontGrouper.cluster(spans)  → group spans by font family/weight/size
  Step 1. GlyphCalibration.train()    → learn per-char OCR/HB width ratios
  Step 2. GlyphCalibration.predict_*  → predict positions for candidate text

Each step is a clean, self-contained class.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from pathlib import Path

import uharfbuzz as hb

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ASSETS_FONTS = Path(__file__).resolve().parent.parent.parent / "assets" / "fonts"

# Minimum span length to include in calibration training data
MIN_CHARS_FOR_TRAINING = 1

# Size tolerance: spans within this many pt of the group median are included
SIZE_TOLERANCE_PT = 2.0

# Known ligature fragments that OCR often splits into separate spans
LIGATURE_FRAGMENTS = frozenset({"fi", "fl", "ff", "ffi", "ffl"})

# PyMuPDF flag bits
FLAG_SUPERSCRIPT = 1
FLAG_BOLD        = 16


# ═══════════════════════════════════════════════════════════════════════════
# Step 0 — Font Group Clustering
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class FontGroup:
    """A cluster of spans sharing the same font family + weight + size class."""

    family:     str                # normalised: "Times", "Helvetica", …
    weight:     str                # "regular" or "bold"
    size_class: float              # median OCR font size (pt) for this group
    spans:      list[dict] = field(default_factory=list, repr=False)

    @property
    def count(self) -> int:
        return len(self.spans)

    def __repr__(self) -> str:
        return (f"FontGroup({self.family}/{self.weight} "
                f"~{self.size_class:.2f}pt, {self.count} spans)")


class FontGrouper:
    """Clusters extracted spans into FontGroups for calibration.

    Usage:
        grouper = FontGrouper()
        groups  = grouper.cluster(spans)
    """

    # ── Font family normalization ──────────────────────────────────────

    _FAMILY_MAP = {
        "times":         "Times",
        "timesnewroman": "Times",
        "arial":         "Helvetica",
        "helvetica":     "Helvetica",
        "calibri":       "Calibri",
        "courier":       "Courier",
        "couriernew":    "Courier",
        "verdana":       "Verdana",
        "segoeui":       "SegoeUI",
    }

    @staticmethod
    def _normalize_family(raw_font: str) -> str:
        """Map raw PDF font name → canonical family."""
        name = raw_font
        # Strip subset prefix  "BCDEEE+Times-Roman" → "Times-Roman"
        if "+" in name:
            name = name.split("+", 1)[1]
        # Lowercase, strip separators
        key = name.lower().replace(" ", "").replace("-", "").replace("_", "")
        # Remove weight/style suffixes for lookup
        for suffix in ("roman", "regular", "bold", "italic", "oblique",
                        "bolditalic", "mt", "psmt", "ps"):
            if key.endswith(suffix):
                key = key[: -len(suffix)]
                break
        for canon_key, canon_name in FontGrouper._FAMILY_MAP.items():
            if key.startswith(canon_key) or canon_key.startswith(key):
                return canon_name
        return name.split("-")[0].split(",")[0].strip()

    # ── Weight detection ───────────────────────────────────────────────

    @staticmethod
    def _detect_weight(span: dict, family: str) -> str:
        """Detect bold from flag bits, font name keywords, or OCR pixel width ratios."""
        if span.get("flags", 0) & FLAG_BOLD:
            return "bold"
        font_lower = span.get("font", "").lower()
        if "bold" in font_lower or "black" in font_lower:
            return "bold"

        # fallback: width-based heuristic
        text = span.get("text", "")
        ocr_w = span.get("w", 0)
        if len(text) < 3 or ocr_w <= 0:
            return "regular"

        font_name = "arial.ttf" if family == "Helvetica" else "times.ttf"
        scale = 4.0/3.0
        size_pt = span.get("sizePt", span.get("fontSize", 12.0) / scale)

        try:
            hb_advs = _hb_shape_advances(text, font_name, size_pt, kerning=True, ligatures=True)
            hb_w = sum(hb_advs) * scale
            if hb_w > 0:
                ratio = ocr_w / hb_w
                # Standard Times New Roman body text ratio is ~1.025.
                # Bold spans typically exceed 1.055.
                if ratio > 1.055:
                    return "bold"
        except Exception:
            pass

        return "regular"

    # ── Junk filters ──────────────────────────────────────────────────

    @staticmethod
    def _is_junk(span: dict) -> bool:
        """Return True if span should be excluded from calibration."""
        text = span.get("text", "").strip()

        if len(text) < MIN_CHARS_FOR_TRAINING:
            return True

        if text in LIGATURE_FRAGMENTS:
            return True

        if span.get("flags", 0) & FLAG_SUPERSCRIPT:
            return True

        return False

    # ── Clustering ─────────────────────────────────────────────────────

    def cluster(self, spans: list[dict]) -> list[FontGroup]:
        """Cluster spans into FontGroups.

        Pipeline:
          1. Normalise font families
          2. Detect weight (regular / bold)
          3. Group by (family, weight)
          4. Within each group, find body-text size via histogram mode
          5. Filter outlier sizes (±SIZE_TOLERANCE_PT from median)
          6. Filter junk spans
          7. Return list of FontGroups
        """
        buckets: dict[tuple[str, str], list[dict]] = {}
        for span in spans:
            family = self._normalize_family(span.get("font", ""))
            weight = self._detect_weight(span, family)
            key = (family, weight)
            buckets.setdefault(key, []).append(span)

        groups: list[FontGroup] = []
        for (family, weight), bucket_spans in buckets.items():
            size_bins: dict[int, list[dict]] = {}
            for s in bucket_spans:
                size_pt = s.get("sizePt", s.get("fontSize", 12.0))
                bin_key = round(size_pt)
                size_bins.setdefault(bin_key, []).append(s)

            for bin_key, bin_spans in size_bins.items():
                clean = [s for s in bin_spans if not self._is_junk(s)]
                if len(clean) < 5:
                    continue

                sizes = [s.get("sizePt", s.get("fontSize", 12.0)) for s in clean]
                median_size = statistics.median(sizes)

                final = [s for s in clean
                         if abs(s.get("sizePt", s.get("fontSize", 12.0))
                                - median_size) <= SIZE_TOLERANCE_PT]
                if len(final) < 5:
                    continue

                groups.append(FontGroup(
                    family=family,
                    weight=weight,
                    size_class=round(median_size, 4),
                    spans=final,
                ))

        groups.sort(key=lambda g: -g.count)
        return groups


# ═══════════════════════════════════════════════════════════════════════════
# Step 1 — Per-Character Calibration
# ═══════════════════════════════════════════════════════════════════════════

# HarfBuzz font cache (shared across calibrations)
_hb_cache: dict[str, tuple] = {}


def _hb_font(font_name: str):
    """Load and cache a HarfBuzz font + upem."""
    if font_name not in _hb_cache:
        path = ASSETS_FONTS / font_name
        if not path.exists():
            raise FileNotFoundError(f"Font not found: {path}")
        face = hb.Face(path.read_bytes())
        font = hb.Font(face)
        _hb_cache[font_name] = (font, face.upem)
    return _hb_cache[font_name]





def _hb_shape_advances(text: str, font_name: str, size_pt: float,
                        kerning: bool = True, ligatures: bool = True
                        ) -> list[float]:
    """HarfBuzz per-cluster advances for a string, in PDF points.

    For ligature glyphs (e.g. "fi" → one glyph), the cluster head carries the
    full advance and the tail characters have advance 0.0.  Callers that need
    per-character advances should use _distribute_ligature_advances_with_text().
    """
    font, upem = _hb_font(font_name)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf, {"kern": kerning, "liga": ligatures})

    advances: dict[int, float] = {}
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        c = info.cluster
        advances[c] = advances.get(c, 0) + (pos.x_advance / upem) * size_pt

    return [advances.get(i, 0.0) for i in range(len(text))]


def _ligature_chars_from_advances(hb_advs: list[float]) -> set[int]:
    """Return the set of character indices that belong to multi-char ligature
    clusters, identified by consecutive runs where only the first element has
    a non-zero advance.

    Both the cluster HEAD and its TAILS are included so callers can skip or
    redistribute the whole cluster uniformly.
    """
    n = len(hb_advs)
    lig_chars: set[int] = set()
    i = 0
    while i < n:
        if hb_advs[i] > 1e-10:
            j = i + 1
            while j < n and hb_advs[j] < 1e-10:
                j += 1
            if j > i + 1:          # cluster spans i..j-1
                for k in range(i, j):
                    lig_chars.add(k)
            i = j
        else:
            i += 1
    return lig_chars


def _distribute_ligature_advances_with_text(hb_advs: list[float],
                                             text: str,
                                             font_name: str,
                                             size_pt: float) -> list[float]:
    """Redistribute ligature cluster advances proportionally using no-ligature
    shaping so every character gets a meaningful individual advance."""
    lig_chars = _ligature_chars_from_advances(hb_advs)
    if not lig_chars:
        return hb_advs

    result = list(hb_advs)
    nolig = _hb_shape_advances(text, font_name, size_pt,
                                kerning=False, ligatures=False)

    i = 0
    while i < len(result):
        if i in lig_chars and result[i] > 1e-10:
            j = i + 1
            while j < len(result) and result[j] < 1e-10:
                j += 1
            cluster_total = result[i]
            nolig_total = sum(nolig[k] for k in range(i, j))
            for k in range(i, j):
                if nolig_total > 1e-10:
                    result[k] = cluster_total * (nolig[k] / nolig_total)
                else:
                    result[k] = cluster_total / (j - i)
            i = j
        else:
            i += 1
    return result


@dataclass
class GlyphCalibration:
    """Per-character width calibration learned from OCR ground truth.

    For each character, stores the median ratio:
        ratio = OCR_advance_px / HarfBuzz_advance_px

    Trained from a single FontGroup's spans.

    Usage:
        cal = GlyphCalibration(group, "times.ttf", scale=4/3)
        cal.train()
        width = cal.predict_width("Hamburgefonstiv")
        chars = cal.predict_positions("Hamburgefonstiv")
    """

    group:        FontGroup
    font_name:    str          = "times.ttf"
    scale:        float        = 4.0 / 3.0    # px per pt

    # Learned data (populated by train())
    ratios:       dict[str, float] = field(default_factory=dict, repr=False)
    global_ratio: float            = 1.0
    ref_size_pt:  float            = 12.0      # median OCR size for predictions

    # Raw training observations (for diagnostics)
    _raw:         dict[str, list[float]] = field(default_factory=dict, repr=False)

    # ── Step 1: Train ──────────────────────────────────────────────────

    def train(self) -> None:
        """Learn per-character OCR/HB width ratios from the font group.

        For each span:
          1. Get the span's OCR per-char advances (chars[].w in px)
          2. Compute HarfBuzz advance for each char at span's sizePt
          3. Ratio = OCR_advance / HB_advance
          4. Collect ratios per character across all spans
        Final: median ratio per character, global fallback = median of all.
        """
        self.ref_size_pt = self.group.size_class
        raw: dict[str, list[float]] = {}
        all_ratios: list[float] = []
        for span in self.group.spans:
            text = span.get("text", "")
            chars = span.get("chars", [])
            if len(chars) < MIN_CHARS_FOR_TRAINING or not text:
                continue

            size_pt = span.get("sizePt", self.ref_size_pt)

            hb_advs = _hb_shape_advances(
                text, self.font_name, size_pt,
                kerning=True, ligatures=True
            )

            # Skip characters in multi-char ligature clusters: the cluster head
            # carries the full advance (not just its share) and tails have 0 —
            # both corrupt the OCR/HB ratio.
            lig_chars = _ligature_chars_from_advances(hb_advs)

            for i, ch in enumerate(chars):
                c = ch.get("c", "")
                ocr_w = ch.get("w", 0)

                if not c or c in ("\t", " ") or ocr_w <= 0 or i >= len(hb_advs):
                    continue

                # Skip final character: PyMuPDF x1 boundaries often include
                # large arbitrary trailing whitespace, corrupting the advance.
                if i == len(chars) - 1:
                    continue

                if i in lig_chars:
                    continue

                hb_w = hb_advs[i] * self.scale
                if hb_w <= 0:
                    continue

                ratio = ocr_w / hb_w

                is_single = (len(text) == 2 and text.endswith(" ") and c == text[0])
                context_key = f"{c}_single" if is_single else c

                raw.setdefault(context_key, []).append(ratio)
                all_ratios.append(ratio)

        self._raw = raw
        self.ratios = {
            c: round(statistics.median(rs), 6)
            for c, rs in raw.items()
            if len(rs) >= 2
        }
        self.global_ratio = (
            round(statistics.median(all_ratios), 6) if all_ratios else 1.0
        )

    # ── Step 2: Predict ────────────────────────────────────────────────

    def predict_positions(self, text: str,
                          font_size_pt: float | None = None,
                          kerning: bool = True,
                          ligatures: bool = True,
                          line_space_px: float | None = None,
                          pdf_chars: list[dict] | None = None) -> list[dict]:
        """Predict per-char positions for candidate text.

        1. Shape with HarfBuzz (kerning-aware) at the given font size
        2. Redistribute ligature cluster advances proportionally
        3. Scale each character's advance by its calibration ratio
        4. Return [{"c": char, "x": cumulative_px, "w": advance_px}, ...]
        """
        size_pt = font_size_pt or self.ref_size_pt
        hb_advances = _hb_shape_advances(
            text, self.font_name, size_pt,
            kerning=kerning, ligatures=ligatures,
        )

        if ligatures:
            hb_advances = _distribute_ligature_advances_with_text(
                hb_advances, text, self.font_name, size_pt,
            )

        result = []
        cum_x = 0.0
        for i, ch in enumerate(text):
            hb_adv = hb_advances[i] * self.scale if i < len(hb_advances) else 0

            is_single = (len(text) == 2 and text.endswith(" ") and i == 0)
            target_key = f"{ch}_single" if is_single else ch

            ratio = self.ratios.get(target_key, self.ratios.get(ch, self.global_ratio))
            cal_adv = hb_adv * ratio

            if ch == " " and line_space_px is not None:
                cal_adv = line_space_px

            # Exact physical footprint: use PDF char advance when available
            if pdf_chars and i < len(pdf_chars) and pdf_chars[i].get("c") == ch:
                cal_adv = pdf_chars[i].get("w", 0.0)

            result.append({
                "c": ch,
                "x": round(cum_x, 2),
                "w": round(cal_adv, 2),
            })
            cum_x += cal_adv

        return result



    # ── Diagnostics ────────────────────────────────────────────────────





