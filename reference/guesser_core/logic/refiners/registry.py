from __future__ import annotations

from .pipeline import RefinerPipeline


class RefinerRegistry:
    """Global registry of redaction refiners.

    Plugins register concrete ``RedactionRefiner`` subclasses with
    ``@register_refiner``. The core orchestrator (``ProcessRedactions``) builds
    its pipeline from whatever is registered, so it never imports concrete
    refiners directly. Removing a refiner plugin simply leaves fewer refiners
    registered — boxes pass through unrefined rather than crashing the core.
    """

    _refiners: dict[str, type] = {}

    @classmethod
    def register(cls, refiner_cls) -> None:
        name = getattr(refiner_cls, "name", None)
        if not name or name == "unnamed":
            raise ValueError(f"{refiner_cls.__name__} must define a 'name' attribute")
        cls._refiners[name] = refiner_cls



    @classmethod
    def build_pipeline(cls, names: list[str] | None = None) -> RefinerPipeline:
        """Instantiate a pipeline from the registry.

        ``names=None`` uses every registered refiner. Refiners that receive no
        matching evidence simply abstain, so it is safe to include all of them.
        """
        if names is None:
            chosen = list(cls._refiners.values())
        else:
            chosen = [cls._refiners[n] for n in names if n in cls._refiners]
        return RefinerPipeline([refiner() for refiner in chosen])


def register_refiner(cls):
    """Class decorator: register a ``RedactionRefiner`` subclass globally."""
    RefinerRegistry.register(cls)
    return cls
