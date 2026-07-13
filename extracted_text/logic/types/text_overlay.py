from dataclasses import dataclass


@dataclass
class TextOverlay:
    page_index: int
    text: str
    font_size_pt: float
    x: float
    y: float
