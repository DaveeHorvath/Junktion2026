"""Thumb-pinch recognition from a Smartgloves RGMP v2 stream.

A pinch needs both halves: the hand's *shape* says which finger is arranged to
meet the thumb, and a *collision* on both fingers' IMUs says they actually met.
`engine.PinchEngine` runs the two together and emits paired `fired`/`released`
events. See `README.md` for how each half is decided.

The entry point is `rgmp_pinch_detector.py`, one directory up.
"""

from pinch_detection.engine import FIRED, RELEASED, PinchEngine, PinchEvent
from pinch_detection.poses import DEFAULT_ORIENTATIONS, PINCHES
from pinch_detection.source import DEFAULT_PORT, stream

__all__ = [
    "DEFAULT_ORIENTATIONS",
    "DEFAULT_PORT",
    "FIRED",
    "PINCHES",
    "PinchEngine",
    "PinchEvent",
    "RELEASED",
    "stream",
]
