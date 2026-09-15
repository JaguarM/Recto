"""A catalogue face's own advances and kern pairs at one pixel size, through
HarfBuzz — the table a page's pens are judged against.

The glyph sets an OCR reader draws with carry advances but no kerning, and a
producer either applied the font's kern table or did not (measured per
document from its pens — `render.js producerMetrics` in the OCR plugin). To
lay a pair the page never wrote the way that producer would have, the
font's own table is needed: this module serves it. Ligatures are turned off
so "fi" measures as f + i, the way a producer that set none laid it.

    font_metrics(path, 16.0) -> {
        "file", "sizePx", "upem",
        "space": px,                 # the space advance
        "adv":   {ch: px},           # plain advance of every listed character
        "kern":  {pair: px},         # every pair whose kerned width differs from adv[a] + adv[b]
        "missing": [ch],             # characters the face has no glyph for
    }
"""
import functools
import os

try:
    import uharfbuzz as hb
except ImportError:  # pragma: no cover - the app degrades without HarfBuzz
    hb = None

CHARS = [chr(c) for c in range(0x21, 0x7F)] + list(
    "‘’“”–—•…§©®°±·"
    "ÀÁÂÄÇÉÈÊËÍÎÏÑÓÔÖÚÛÜß"
    "àáâäçéèêëíîïñóôöúûüÿ"
) + ["ﬁ", "ﬂ"]

_PLAIN = {"kern": False, "liga": False, "clig": False, "calt": False, "dlig": False}
_KERN = dict(_PLAIN, kern=True)


@functools.lru_cache(maxsize=64)
def font_metrics(font_path, size_px):
    """The face's advances and kern pairs at ``size_px`` (image px). Cached per
    (path, size); the first call shapes every pair once (about a second)."""
    if hb is None:
        raise RuntimeError("uharfbuzz is not installed")
    size_px = float(size_px)
    with open(font_path, "rb") as f:
        face = hb.Face(f.read())
    font = hb.Font(face)
    upem = face.upem

    def shape(text, feats):
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(font, buf, feats)
        width = sum(p.x_advance for p in buf.glyph_positions) / upem * size_px
        return width, [i.codepoint for i in buf.glyph_infos]

    adv, missing = {}, []
    for ch in CHARS:
        w, gids = shape(ch, _PLAIN)
        if gids and gids[0] != 0:
            adv[ch] = w
        else:
            missing.append(ch)
    space, _ = shape(" ", _PLAIN)

    kern = {}
    present = list(adv)
    for a in present:
        for b in present:
            w, gids = shape(a + b, _KERN)
            if len(gids) != 2:
                continue        # a substitution happened despite the flags: not a plain pair
            k = w - adv[a] - adv[b]
            if abs(k) > 1e-6:
                kern[a + b] = k

    return {"file": os.path.basename(font_path), "sizePx": size_px, "upem": upem,
            "space": space, "adv": adv, "kern": kern, "missing": missing}
