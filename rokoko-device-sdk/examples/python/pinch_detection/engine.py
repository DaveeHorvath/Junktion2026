"""Frames in, pinch events out.

One tick does four things in order: featurise the frame, read the hand's shape,
debounce that shape into held-or-not, and — for a shape being held — look back
through the acceleration history for the collision that confirms it.

Events are paired rather than left to the caller — see :mod:`pinch_detection.pairing`,
which owns that decision.
"""

from __future__ import annotations

from dataclasses import dataclass

from pinch_detection.contact import ContactDetector
from pinch_detection.frames import HandFrame
from pinch_detection.kinematics import Features, Kinematics, featurize, kinematics
# FIRED and RELEASED are re-exported: a consumer switching on
# PinchEvent.phase should not have to know which module defines them.
from pinch_detection.pairing import FIRED, RELEASED, Pairing  # noqa: F401
from pinch_detection.poses import DEFAULT_ORIENTATIONS, DWELL_US, PINCHES, PoseState, matches

# Extra slack on top of the dwell when deciding how far back to scan. The dwell is
# the real quantity: the collision that creates the shape is always at least one
# dwell older than the moment anything starts looking for it.
PRE_WINDOW_SLACK_US = 60_000

# A clock that jumps back by more than this restarted, rather than arriving out of
# order. Everything keyed on the old clock is then in the future and can never
# expire, so it is all dropped.
CLOCK_RESTART_US = 1_000_000


@dataclass(frozen=True)
class PinchEvent:
    hand: str
    pinch: str              # one of PINCHES
    phase: str              # FIRED or RELEASED
    count: int              # shared by the two halves of one pinch
    t_us: int               # sensor clock; per glove, not comparable between them


class _Hand:
    def __init__(self, scale: float, orientations: tuple[str, ...]) -> None:
        self.poses = [PoseState() for _ in PINCHES]
        self.contacts = ContactDetector(scale)
        self.orientations = orientations
        self.previous: Kinematics | None = None
        self.newest_us: int | None = None
        self.pairing = Pairing(len(PINCHES))


class PinchEngine:
    """Drive with :meth:`update`, one frame at a time, and read the events it returns."""

    def __init__(
        self,
        threshold_scale: float = 1.0,
        orientations: tuple[str, ...] = DEFAULT_ORIENTATIONS,
    ) -> None:
        self._scale = threshold_scale
        self._orientations = orientations
        self._hands: dict[str, _Hand] = {}

    def update(self, frame: HandFrame) -> list[PinchEvent]:
        hand = self._hands.get(frame.hand)
        if hand is None:
            hand = self._hands[frame.hand] = _Hand(self._scale, self._orientations)

        if hand.newest_us is not None and frame.t_us < hand.newest_us - CLOCK_RESTART_US:
            # The glove reconnected and its clock started again. Nothing held can
            # be compared against what arrives next, so none of it survives.
            hand.contacts.reset()
            hand.previous = None
            for pose in hand.poses:
                pose.held = False
        hand.newest_us = frame.t_us

        features: Features = featurize(frame)
        kine = kinematics(frame, features, hand.previous)
        hand.previous = kine
        hand.contacts.push(features, kine)

        events: list[PinchEvent] = []
        for bit in range(len(PINCHES)):
            edge = hand.poses[bit].update(matches(bit, kine, hand.orientations), frame.t_us)
            hand.contacts.scan(
                bit,
                armed=hand.poses[bit].held,
                now_us=frame.t_us,
                pre_window_us=DWELL_US + PRE_WINDOW_SLACK_US,
            )
            if edge == "exit":
                events += _emit(frame, bit, hand.pairing.shape_ended(bit))

        for bit in hand.contacts.resolve(frame.t_us):
            events += _emit(
                frame, bit, hand.pairing.fired(bit, shape_still_held=hand.poses[bit].held)
            )

        return events


def _emit(frame: HandFrame, bit: int, pairs) -> list[PinchEvent]:
    return [
        PinchEvent(hand=frame.hand, pinch=PINCHES[bit], phase=phase,
                   count=count, t_us=frame.t_us)
        for phase, count in pairs
    ]
