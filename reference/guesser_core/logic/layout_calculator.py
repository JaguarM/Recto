class LayoutCalculator:
    """
    Implements Aspose.Words width calculation logic and twip conversions.
    """
    
    # 1 Point = 20 Twips. Microsoft Word Layout Engine uses Twips internally.
    TWIPS_PER_POINT = 20.0

    def __init__(self, font_size_pt: float, upem: int):
        self.font_size_pt = font_size_pt
        self.upem = upem
        
    def advance_to_points(self, advance: int) -> float:
        """
        Aspose fundamental width formula: Width = (Advance * FontSize) / Em
        """
        return (advance * self.font_size_pt) / self.upem

    def points_to_twips(self, points: float) -> int:
        """
        Convert points to twips, matching Aspose/Word rounding logic.
        Generally round(points * 20)
        """
        return round(points * self.TWIPS_PER_POINT)
        

        
    def calculate_run_width_twips(self, shaped_glyphs: list) -> int:
        """
        Calculates the total width of a run in twips.
        """
        total_advance = sum(g['x_advance'] for g in shaped_glyphs)
        points = self.advance_to_points(total_advance)
        return self.points_to_twips(points)

    def calculate_justified_spaces(self, shaped_glyphs: list, container_width_twips: int, space_codepoint=32) -> dict:
        """
        Given a line of glyphs and a container width, calculates how much extra space
        to distribute to the space characters to justify the line.
        """
        total_advance = sum(g['x_advance'] for g in shaped_glyphs)
        line_width_twips = self.points_to_twips(self.advance_to_points(total_advance))
        
        # Identify spaces across the glyphs
        space_count = sum(1 for g in shaped_glyphs if g['glyph_id'] == space_codepoint) # Naive, actual shaper may map 32 to specific glyph id.
        # NOTE: A better way is to find glyph_id for space from the font.
        
        if space_count == 0:
            return {"extra_space_per_gap_twips": 0, "remainder": 0}
            
        extra_space_total = container_width_twips - line_width_twips
        extra_space_per_gap = extra_space_total // space_count
        remainder = extra_space_total % space_count
        
        return {
            "extra_space_per_gap_twips": extra_space_per_gap,
            "remainder": remainder,
            "space_count": space_count,
            "original_line_width_twips": line_width_twips,
            "target_container_width": container_width_twips
        }



