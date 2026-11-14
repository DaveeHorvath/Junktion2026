"""The four pinches, and deciding when a hand is holding one.

A pinch needs both halves. The pose says the hand is *shaped* for a thumb-to-N
pinch and names which finger has come furthest round; the contact trigger says the
two fingers actually met. Neither is sufficient alone: no amount of flexion says
which finger is touching the thumb, and a collision on its own does not say which
pair produced it.

A pose is a shape and does not name a hand. Every constraint here is already
hand-relative — orientation is categorised against the frame's own hand, so
fingers_up means the same on either — so both gloves are matched against every
pose and the event carries which one made it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from pinch_detection.kinematics import Kinematics

# In the order the fire counters use. Each names the finger that must be reaching
# furthest, and the collision site that confirms it.
PINCHES = ("thumb_index", "thumb_middle", "thumb_ring", "thumb_pinky")
REACHING = ("index", "middle", "ring", "pinky")

# The hand attitudes a pinch is accepted in. The same for all four: gestures that
# differ only in which finger moves should not differ in how the hand may be held.
# edge_down is the handshake edge, where a hand naturally sits when pinching at
# rest; fingers_up is a raised hand. The backhand attitude is left out as awkward
# to pinch in, and palm-up and palm-down as easy to hold by accident.
DEFAULT_ORIENTATIONS = ("fingers_up", "edge_down")

# Shorter than a pose used for anything else, because a pinch is a tap and dwell
# is felt directly as latency. Safe to shorten because the collision is what
# rejects a false positive, so the shape need not hold as long to earn trust.
DWELL_US = 60_000
EXIT_US = 40_000


@dataclass
class PoseState:
    """Debounces one pinch's shape on one hand into held / not held.

    Exit applies while settling as well as while held. Without that, entry is
    strict where exit is tolerant: a hand on a classifier boundary chatters at
    frame rate while looking perfectly steady, accumulates a few frames of dwell
    over and over, and never settles. The pose appears to match and nothing fires.
    """

    dwell_us: int = DWELL_US
    exit_us: int = EXIT_US
    held: bool = False
    _matched_since: int | None = field(default=None, repr=False)
    _unmatched_since: int | None = field(default=None, repr=False)

    def update(self, matches: bool, t_us: int) -> str | None:
        """Advance by one frame. Returns "enter", "exit", or None."""
        if not self.held:
            if matches:
                self._unmatched_since = None
                if self._matched_since is None:
                    self._matched_since = t_us
                if t_us - self._matched_since >= self.dwell_us:
                    self.held = True
                    self._matched_since = self._unmatched_since = None
                    return "enter"
            elif self._matched_since is not None:
                if self._unmatched_since is None:
                    self._unmatched_since = t_us
                if t_us - self._unmatched_since >= self.exit_us:
                    self._matched_since = self._unmatched_since = None
            return None

        if matches:
            self._unmatched_since = None
            return None
        if self._unmatched_since is None:
            self._unmatched_since = t_us
        if t_us - self._unmatched_since >= self.exit_us:
            self.held = False
            self._matched_since = self._unmatched_since = None
            return "exit"
        return None


def matches(bit: int, kine: Kinematics, orientations: tuple[str, ...]) -> bool:
    """Whether the hand is shaped for pinch *bit* this frame.

    Two constraints, and deliberately not a third: the reaching finger is what
    separates the four, so the individual finger states are left open.
    Constraining both would reject the same pinch twice for the same reason, and
    per-finger flexion is the half that does not survive a different hand.
    """
    if orientations and kine.orientation not in orientations:
        return False
    return kine.most_reaching == REACHING[bit]
