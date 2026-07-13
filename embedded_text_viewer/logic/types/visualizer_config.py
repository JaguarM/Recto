from dataclasses import dataclass


@dataclass
class VisualizerConfig:
    text_color: tuple[float, float, float] = (0.0, 0.4, 1.0)  # blue
