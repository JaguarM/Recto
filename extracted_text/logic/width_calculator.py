try:
    import uharfbuzz as hb
except ImportError:
    hb = None
import os


def _resolve_font_path(font_name):
    """Search local and assets/fonts for a TTF file; return path or None."""
    candidates = [
        font_name,
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'assets', 'fonts', font_name),
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'assets', 'fonts', font_name + '.ttf'),
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def get_text_widths(texts, font_name="times.ttf", font_size=12, force_uppercase=False, scale_factor=1.35, kerning=True, ligatures=True, space_width=None):
    """
    Calculates pixel widths for a list of text strings data.
    Matches exact shaping rules with Harfbuzz from the typography engine.
    """
    if not hb:
         return [{"text": t, "width": 0, "error": "uharfbuzz library is not installed"} for t in texts]

    results = []

    font_path = _resolve_font_path(font_name)
    if not font_path:
        return [{"text": t, "width": 0, "error": f"Font {font_name} not found"} for t in texts]
            
    try:
        with open(font_path, 'rb') as f:
            font_data = f.read()
            
        face = hb.Face(font_data)
        font = hb.Font(face)
        upem = face.upem
        
        # Create features dict
        features = {"kern": bool(kerning), "liga": bool(ligatures)}
        
        # Find the glyph ID for the space character so we can override it
        space_buf = hb.Buffer()
        space_buf.add_str(" ")
        space_buf.guess_segment_properties()
        hb.shape(font, space_buf, features)
        space_glyph_id = space_buf.glyph_infos[0].codepoint if space_buf.glyph_infos else None

        for text in texts:
            if not text:
                results.append({"text": text, "width": 0})
                continue
                
            measure_text = text.upper() if force_uppercase else text
            
            buf = hb.Buffer()
            buf.add_str(measure_text)
            buf.guess_segment_properties()
            
            hb.shape(font, buf, features)
            
            # Apply identical per-glyph rendering math from typography_engine
            total_advance = 0
            chars = []
            for pos, info in zip(buf.glyph_positions, buf.glyph_infos):
                # Record position before this glyph's advance
                char_str = measure_text[info.cluster] if info.cluster < len(measure_text) else ''
                chars.append({"c": char_str, "x": total_advance})

                if space_width is not None and space_glyph_id is not None and info.codepoint == space_glyph_id:
                    pixel_advance = float(space_width)
                else:
                    pixel_advance = (pos.x_advance / upem) * font_size * scale_factor
                total_advance += pixel_advance
                
            results.append({"text": text, "width": total_advance, "chars": chars})
            
        return results
        
    except Exception as e:
        return [{"text": t, "width": 0, "error": str(e)} for t in texts]


def get_justified_space_width(text, block_w, font_name="times.ttf", font_size=12,
                               force_uppercase=False, scale_factor=1.35,
                               kerning=True, ligatures=True):
    """
    Compute the pixel width each space character must have so that the
    total shaped width of *text* equals *block_w* (the justified container width).

    Returns the per-space pixel width (float), or None if the text contains
    no spaces or the calculation cannot be performed.
    """
    if not hb or not text or block_w is None or block_w <= 0:
        return None

    font_path = _resolve_font_path(font_name)
    if not font_path:
        return None

    try:
        with open(font_path, 'rb') as f:
            font_data = f.read()

        face = hb.Face(font_data)
        font = hb.Font(face)
        upem = face.upem
        features = {"kern": bool(kerning), "liga": bool(ligatures)}

        # Identify the space glyph
        space_buf = hb.Buffer()
        space_buf.add_str(" ")
        space_buf.guess_segment_properties()
        hb.shape(font, space_buf, features)
        space_glyph_id = space_buf.glyph_infos[0].codepoint if space_buf.glyph_infos else None
        if space_glyph_id is None:
            return None

        measure_text = text.upper() if force_uppercase else text

        buf = hb.Buffer()
        buf.add_str(measure_text)
        buf.guess_segment_properties()
        hb.shape(font, buf, features)

        non_space_advance = 0.0
        space_count = 0
        for pos, info in zip(buf.glyph_positions, buf.glyph_infos):
            if info.codepoint == space_glyph_id:
                space_count += 1
            else:
                non_space_advance += (pos.x_advance / upem) * font_size * scale_factor

        if space_count == 0:
            return None

        justified_space_w = (block_w - non_space_advance) / space_count
        return max(0.0, justified_space_w)  # clamp to non-negative

    except Exception:
        return None


def get_available_fonts():
    # rudimentary list of common fonts or scan directory
    font_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'assets', 'fonts')
    asset_fonts = []
    if os.path.exists(font_dir) and os.path.isdir(font_dir):
        asset_fonts = [f for f in os.listdir(font_dir) if f.lower().endswith('.ttf')]

    fallback_fonts = [
        # "times.ttf",
        # "cour.ttf",
        # "arial.ttf",
        # "calibri.ttf",
        # "segoeui.ttf"
    ]

    # Combine ensuring no duplicates and asset fonts are first
    combined_fonts = asset_fonts.copy()
    for f in fallback_fonts:
        if f not in combined_fonts:
            combined_fonts.append(f)

    return combined_fonts
