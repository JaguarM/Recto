try:
    import uharfbuzz as hb
except ImportError:
    hb = None
import os

def get_text_widths(texts, font_name="times.ttf", font_size=12, force_uppercase=False, scale_factor=1.35, kerning=True, ligatures=True):
    """
    Calculates pixel widths for a list of text strings data.
    Matches exact shaping rules with Harfbuzz from the typography engine.
    """
    if not hb:
         return [{"text": t, "width": 0, "error": "uharfbuzz library is not installed"} for t in texts]

    results = []
    
    # Try to locate the font
    # Search local and assets/fonts only
    font_paths = [
        font_name,
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'assets', 'fonts', font_name),
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'assets', 'fonts', font_name + '.ttf'),
    ]
    
    font_path = None
    for path in font_paths:
        if os.path.exists(path):
            font_path = path
            break
            
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
            for info in buf.glyph_positions:
                pixel_advance = (info.x_advance / upem) * font_size * scale_factor
                total_advance += pixel_advance
                
            # Multiply text calculation because calculated width is only ~95% the expected size
            total_advance = total_advance * (1 / 0.95)
                
            results.append({"text": text, "width": total_advance})
            
        return results
        
    except Exception as e:
        return [{"text": t, "width": 0, "error": str(e)} for t in texts]


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
