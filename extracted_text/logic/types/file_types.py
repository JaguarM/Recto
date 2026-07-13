from __future__ import annotations
from pydantic import BaseModel


class Rect(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float

    @classmethod
    def new(cls, x0: float, y0: float, x1: float, y1: float) -> "Rect":
        min_x, max_x = (x0, x1) if x0 <= x1 else (x1, x0)
        min_y, max_y = (y0, y1) if y0 <= y1 else (y1, y0)
        return cls(x0=min_x, y0=min_y, x1=max_x, y1=max_y)


class FontTextRun(BaseModel):
    page_index: int
    text: str
    bbox: Rect
    font_size_pt: float


class FontRunReport(BaseModel):
    runs: list[FontTextRun] = []
