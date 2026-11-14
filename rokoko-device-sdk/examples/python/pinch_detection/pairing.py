"""Turning two engine signals into the pairs a consumer is promised.

Every ``fired`` is closed by exactly one ``released``, sharing a count, per pinch
per hand. Neither signal can give that alone: the collision is the only thing that
says a pinch happened, and the shape ending is the only thing that says when it
stopped — but the shape is the hand's *posture*, so it also ends every time
fingers approach without meeting. Driving the release straight off the shape sends
releases for pinches that never fired and repeats carrying a stale count; measured
against gloves, 16% of all releases.

This is its own class because the contract is what a consumer actually depends on,
and deciding it inline leaves nothing a test can reach.
"""

from __future__ import annotations

FIRED, RELEASED = "fired", "released"


class Pairing:
    """One hand's counters and open pinches."""

    def __init__(self, count: int) -> None:
        self._counts = [0] * count
        self._open: set[int] = set()

    def fired(self, bit: int, shape_still_held: bool) -> list[tuple[str, int]]:
        """A confirmed collision. Returns (phase, count) pairs to publish, in order."""
        events: list[tuple[str, int]] = []

        # Tapping twice without opening the hand keeps one shape across both
        # collisions, so there is no edge between them to close the first. A new
        # contact is itself the end of the previous one.
        if bit in self._open:
            events.append((RELEASED, self._counts[bit]))
            self._open.discard(bit)

        self._counts[bit] += 1
        events.append((FIRED, self._counts[bit]))

        # A contact settles over several frames, so a quick tap can be confirmed
        # after the fingers have parted and the shape has gone. There is no later
        # edge to close it, so close it now rather than leave it open for ever.
        if shape_still_held:
            self._open.add(bit)
        else:
            events.append((RELEASED, self._counts[bit]))
        return events

    def shape_ended(self, bit: int) -> list[tuple[str, int]]:
        """The hand left the shape. Closes a pinch if one is open, and otherwise
        says nothing — a shape entered and left without the fingers meeting closes
        nothing."""
        if bit not in self._open:
            return []
        self._open.discard(bit)
        return [(RELEASED, self._counts[bit])]
