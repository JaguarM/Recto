class LineBreaker:
    """
    Simulates a basic Word/Aspose line breaking greedy algorithm.
    """
    def __init__(self, layout_calculator, space_glyph_id):
        self.lc = layout_calculator
        self.space_glyph_id = space_glyph_id

    def break_lines(self, shaped_glyphs, container_width_twips):
        """
        Takes a list of shaped glyphs and breaks them into lines that fit within
        container_width_twips. Returns a list of lines (where each line is a list of glyphs).
        """
        lines = []
        current_line = []
        current_width_advances = 0
        
        # Very basic greedy algorithm: add words until we overflow.
        # This implementation requires tokenizing by spaces or words first, 
        # or tracking break opportunities. We'll track the last space pos.
        
        last_space_index = -1

        for g in shaped_glyphs:
            current_line.append(g)
            current_width_advances += g['x_advance']
            
            if g['glyph_id'] == self.space_glyph_id:
                last_space_index = len(current_line) - 1
                
            current_width_pt = self.lc.advance_to_points(current_width_advances)
            current_width_twips = self.lc.points_to_twips(current_width_pt)
            
            if current_width_twips > container_width_twips:
                # Overflow! Break at the last space if possible
                if last_space_index != -1 and last_space_index != len(current_line)-1:
                    # Break at space
                    # The space should stay with the current line usually (or be ignored in width calc for trailing spaces)
                    # For simplicity, we keep the space on the current line, next line starts after space.
                    line_to_keep = current_line[:last_space_index+1]
                    lines.append(line_to_keep)
                    
                    # Reset for next line
                    current_line = current_line[last_space_index+1:]
                    current_width_advances = sum(g['x_advance'] for g in current_line)
                    last_space_index = -1
                else:
                    # Very long word (no spaces), force break a character early (very naive fallback)
                    lines.append(current_line[:-1])
                    current_line = [g]
                    current_width_advances = g['x_advance']
                    last_space_index = -1
                    
        if current_line:
            lines.append(current_line)
            
        return lines

