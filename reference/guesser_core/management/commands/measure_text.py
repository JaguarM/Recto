from django.core.management.base import BaseCommand
from guesser_core.logic.shaper import HarfBuzzShaper
from guesser_core.logic.layout_calculator import LayoutCalculator
from guesser_core.logic.line_breaker import LineBreaker


class Command(BaseCommand):
    help = "Shape and measure text width using HarfBuzz and Aspose-compatible layout math"

    def add_arguments(self, parser):
        parser.add_argument("--text", type=str, required=True, help="Text string to shape and measure")
        parser.add_argument("--font", type=str, required=True, help="Path to TTF font file")
        parser.add_argument("--size", type=float, required=True, help="Font size in points")
        parser.add_argument("--width", type=float, required=False, help="Container width in points for line breaking / justification")
        parser.add_argument("--justify", action="store_true", help="Apply ParagraphAlignment.Justify mathematics")

    def handle(self, *args, **options):
        shaper = HarfBuzzShaper(options["font"])
        upem = shaper.get_upem()
        self.stdout.write(f"[Shaper] Font UPEM: {upem}")

        space_glyphs = shaper.shape_text(" ")
        space_glyph_id = space_glyphs[0]["glyph_id"] if space_glyphs else 3
        self.stdout.write(f"[Shaper] Space Glyph ID: {space_glyph_id}")

        shaped = shaper.shape_text(options["text"])
        self.stdout.write(f"[Shaper] Extracted {len(shaped)} glyph advances.")

        lc = LayoutCalculator(options["size"], upem)

        total_twips = lc.calculate_run_width_twips(shaped)
        self.stdout.write(f"[Layout] Total Unbroken Line Width: {total_twips} twips ({total_twips / 20.0} pts)")

        if options["width"] is not None:
            container_twips = lc.points_to_twips(options["width"])
            self.stdout.write(f"[Layout] Container Width: {container_twips} twips")

            breaker = LineBreaker(lc, space_glyph_id)
            lines = breaker.break_lines(shaped, container_twips)
            self.stdout.write(f"[Break] Broke text into {len(lines)} lines")

            for i, line in enumerate(lines):
                line_twips = lc.calculate_run_width_twips(line)
                self.stdout.write(f"  Line {i + 1}: {len(line)} glyphs, {line_twips} twips")

                if options["justify"]:
                    justify_info = lc.calculate_justified_spaces(line, container_twips, space_glyph_id)
                    if justify_info.get("space_count", 0) > 0:
                        extra = justify_info["extra_space_per_gap_twips"]
                        rem = justify_info["remainder"]
                        self.stdout.write(f"    [Justify] Expanding {justify_info['space_count']} spaces by {extra} twips (remainder {rem})")
