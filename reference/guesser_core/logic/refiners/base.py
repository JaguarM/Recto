from __future__ import annotations
from dataclasses import dataclass
from abc import ABC, abstractmethod
from typing import Any


@dataclass
class DetectedBox:
    """Redaction box in image pixel space (see guesser_core.logic.geometry)."""
    page: int
    x: float
    y: float
    width: float
    height: float


@dataclass
class BoxProposal:
    """A refiner's edge proposal for one box. None = no opinion on that edge."""
    x: float | None = None
    x2: float | None = None
    confidence: float = 1.0
    source: str = ""


class RedactionRefiner(ABC):
    name: str = "unnamed"

    @abstractmethod
    def refine(self, box: DetectedBox, evidence: Any) -> BoxProposal:
        """Return a proposal. Return BoxProposal() (all None) to abstain."""
        ...
