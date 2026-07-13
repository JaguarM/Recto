import uharfbuzz as hb

class HarfBuzzShaper:
    """
    Wraps uharfbuzz to retrieve bare glyph advances for text.
    Matches the Aspose approach of querying an internal text shaper.
    """
    def __init__(self, font_path: str):
        self.font_path = font_path
        self.blob = hb.Blob.from_file_path(font_path)
        self.face = hb.Face(self.blob)
        self.font = hb.Font(self.face)
        # Font needs to be configured with the proper scale and ppem
        # Aspose fundamentally extracts 'unscaled' font design metrics 
        # upEM = self.face.upem
        # self.font.scale = (upEM, upEM)

    def shape_text(self, text: str, kerning: bool = True):
        """
        Shapes LTR text and returns basic advances for rendering math.
        """
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties() # LTR, script, language

        features = {"kern": kerning}
        hb.shape(self.font, buf, features)
        
        infos = buf.glyph_infos
        positions = buf.glyph_positions
        
        results = []
        for info, pos in zip(infos, positions):
             results.append({
                 "glyph_id": info.codepoint,
                 "cluster": info.cluster,
                 "x_advance": pos.x_advance,
                 "y_advance": pos.y_advance,
                 "x_offset": pos.x_offset,
                 "y_offset": pos.y_offset
             })
        return results

    def get_upem(self):
        return self.face.upem

