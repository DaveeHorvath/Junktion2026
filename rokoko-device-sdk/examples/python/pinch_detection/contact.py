"""Two fingers meeting, detected from the collision.

A fingertip position is projected forward from a sensor sitting mid-bone, and that
estimate is what hand size distorts most — so "are these tips close" is the least
trustworthy thing available. A collision is measured directly: both fingers stop,
hard, at the same instant.

Four things have to hold, and each rules out a different impostor:

1. both fingers spike together — a spike on one is that finger doing something else
2. the hub stays quiet — a jolt through the glove spikes every IMU at once
3. the spike drives them *apart* — setting off toward each other looks the same
4. they were closing beforehand — letting go looks the same as meeting

The collision that makes a pinch happens *before* the shape has held long enough
to be believed, so by the time anything is armed the evidence is already past.
That is why this keeps a rolling history and scans backwards rather than judging
each frame as it arrives.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

import numpy as np

from pinch_detection.frames import SITE_INDEX
from pinch_detection.kinematics import Features, Kinematics

# Collision thresholds per pinch, m/s². Not uniform, and deliberately so: the
# pinky's is a fifth of the index's because it meets the thumb while barely
# flexed, so there is little travel to stop. Raising it to match the others does
# not make detection stricter, it stops the pinky working.
THRESHOLDS = (10.0, 10.0, 6.0, 2.0)

# What fraction of the threshold the *partner* has to reach. The two sites are
# doing different things: the finger swings and the thumb anchors, so the anchor
# reads far weaker. One shared bar rejects almost every real contact.
PARTNER_FRACTION = 0.25

CONTACT_WINDOW_US = 20_000      # how far apart two IMUs may report one collision
REARM_COOLDOWN_US = 200_000     # minimum gap between fires of one pinch
HUB_REJECTION_RATIO = 2.0       # how much more the fingers must spike than the hub
VELOCITY_TAU_US = 500_000       # forgetting constant for the closing-speed estimate

# A little over a second at 83 Hz: enough to cover the longest pre-window a dwell
# can ask for, plus a few time constants of the closing-speed estimate.
BUFFER_FRAMES = 128

# How much opposing motion still counts as "not already moving", as a fraction of
# what a launch at the trigger's own threshold would impart. Derived from the
# threshold so one constant means the same to triggers tuned apart.
_LAUNCH_SECONDS = 0.04
_OPPOSING_FRACTION = 0.25


def slack_for(threshold: float) -> float:
    return abs(threshold) * _LAUNCH_SECONDS * _OPPOSING_FRACTION


class Filtered:
    """A site's rolling history, high-passed.

    One-pole high-pass (an EMA bias subtracted) plus a magnitude deadband: it
    removes residual gravity and sensor drift so the closing-speed integral does
    not slide, and zeroes anything small so a still finger contributes exact
    zeroes rather than a creeping bias.
    """

    def __init__(self, deadband: float = 0.8, bias_tau_s: float = 1.5) -> None:
        self._deadband = deadband
        self._tau = bias_tau_s
        self._bias = np.zeros(3)
        self._seeded = False
        self._last_us: int | None = None
        self.t = deque(maxlen=BUFFER_FRAMES)
        self.a = deque(maxlen=BUFFER_FRAMES)
        self.mag = deque(maxlen=BUFFER_FRAMES)

    def push(self, t_us: int, accel: np.ndarray) -> None:
        if not self._seeded:
            # Seed to the first sample so a startup offset does not ring through
            # the high-pass for a full time constant.
            self._bias = accel.copy()
            self._seeded = True
            self._last_us = t_us
            out = np.zeros(3)
        else:
            dt = (t_us - self._last_us) / 1e6
            self._last_us = t_us
            if dt <= 0:
                out = np.zeros(3)
            else:
                self._bias += (accel - self._bias) * min(1.0, dt / self._tau)
                out = accel - self._bias
                if float(out @ out) < self._deadband ** 2:
                    out = np.zeros(3)
        self.t.append(t_us)
        self.a.append(out)
        self.mag.append(float(np.linalg.norm(out)))

    def clear(self) -> None:
        self.t.clear(); self.a.clear(); self.mag.clear()
        self._seeded = False
        self._bias = np.zeros(3)
        self._last_us = None

    def window(self, lo_us: int, hi_us: int):
        """Indices whose timestamps fall in [lo, hi]."""
        return [i for i, t in enumerate(self.t) if lo_us <= t <= hi_us]

    def peak(self, lo_us: int, hi_us: int) -> tuple[float, np.ndarray]:
        best, vec = 0.0, np.zeros(3)
        for i in self.window(lo_us, hi_us):
            if self.mag[i] > best:
                best, vec = self.mag[i], self.a[i]
        return best, vec


@dataclass
class Contact:
    """A collision one trigger believes it saw, waiting to find out if it is the best account."""

    bit: int
    hand: str
    t_us: int
    strength: float
    activity: float
    latest_us: int


@dataclass
class _Settling:
    candidates: list[Contact] = field(default_factory=list)
    opened_us: int = 0
    deadline_us: int = 0


class ContactDetector:
    """Per hand: the rolling buffers, the four gates, and arbitration between rivals."""

    # A collision is an event with duration, so the decision about it needs one
    # too. Decided inside one frame, whichever trigger crosses first wins
    # unopposed and a closer rival arriving two frames later fires as well —
    # two pinches reported for one finger being hit.
    SETTLE_WINDOW_US = CONTACT_WINDOW_US * 2
    MAX_SETTLE_WINDOWS = 3

    def __init__(self, threshold_scale: float = 1.0) -> None:
        self.thresholds = [t * threshold_scale for t in THRESHOLDS]
        self._accel = {name: Filtered() for name in SITE_INDEX}
        self._gyro = {name: Filtered(deadband=0.15) for name in SITE_INDEX}
        self._tips: deque[tuple[int, np.ndarray]] = deque(maxlen=BUFFER_FRAMES)
        self._scan_from: dict[int, int] = {}
        self._last_contact: dict[str, int] = {}   # per finger, guards the seam between frames
        self._settling: _Settling | None = None

    # ── ingest ────────────────────────────────────────────────────────────────

    def push(self, features: Features, kine: Kinematics) -> None:
        for name, i in SITE_INDEX.items():
            self._accel[name].push(features.t_us, features.accel[i])
            self._gyro[name].push(features.t_us, features.gyro[i])
        # Tip geometry is kept per frame so a collision found a hundred
        # milliseconds ago is judged against where the fingers were then, not
        # where they have since travelled to.
        self._tips.append((features.t_us, kine.tips.copy()))

    def reset(self) -> None:
        for f in self._accel.values():
            f.clear()
        for f in self._gyro.values():
            f.clear()
        self._tips.clear()
        self._scan_from.clear()
        self._last_contact.clear()
        self._settling = None

    # ── detection ─────────────────────────────────────────────────────────────

    def scan(self, bit: int, armed: bool, now_us: int, pre_window_us: int) -> None:
        """Look for pinch *bit*'s collision in whatever has not been scanned yet."""
        finger = ("thumb", "index", "middle", "ring", "pinky")[bit + 1]
        if not armed:
            self._scan_from.pop(bit, None)
            return

        if bit not in self._scan_from:
            # Open the scan behind the current frame: in a pinch the collision
            # happens before the shape has held long enough to be believed.
            self._scan_from[bit] = now_us - pre_window_us

        start = self._scan_from[bit]
        if now_us <= start:
            return
        self._scan_from[bit] = now_us

        hit = self._detect(bit, finger, start, now_us)
        if hit is not None:
            self._settle(hit)

    def _detect(self, bit: int, finger: str, from_us: int, to_us: int) -> Contact | None:
        threshold = self.thresholds[bit]
        partner_threshold = threshold * PARTNER_FRACTION
        slack = slack_for(threshold)
        a, b, hub = self._accel[finger], self._accel["thumb"], self._accel["hub"]

        for i in a.window(from_us, to_us):
            t = a.t[i]
            if t <= from_us or a.mag[i] < threshold:
                continue

            # (1) the partner's strongest sample nearby — strongest rather than
            # nearest in time, since two IMUs sample independently.
            peak_b, accel_b = b.peak(t - CONTACT_WINDOW_US, t + CONTACT_WINDOW_US)
            if peak_b < partner_threshold:
                continue

            # (2) the hand itself stayed comparatively still. The partner is
            # scaled back into the primary's terms first, or a reduced partner bar
            # would make this test proportionally stricter.
            hub_peak, _ = hub.peak(t - CONTACT_WINDOW_US, t + CONTACT_WINDOW_US)
            quieter = min(a.mag[i], peak_b / PARTNER_FRACTION)
            if hub_peak * HUB_REJECTION_RATIO > quieter:
                continue

            toward = self._toward(bit, t)

            # (3) a launch accelerates the pair together; a collision drives them
            # apart. A deadband rather than a sign test: this projects a filtered
            # difference onto a direction from a different sensor stream, so near
            # zero the sign is not evidence of anything.
            if toward is not None and float((a.a[i] - accel_b) @ toward) > slack:
                continue

            # (4) letting go looks exactly like meeting, and passes (3) either
            # way. What separates them is what came before: a collision interrupts
            # fingers still closing, a release starts from fingers at rest.
            if toward is not None and self._closing_before(finger, toward, t) <= slack:
                continue

            peak_a = max(a.mag[j] for j in a.window(t - CONTACT_WINDOW_US, t + CONTACT_WINDOW_US))
            return Contact(
                bit=bit,
                hand="",
                t_us=t,
                strength=min(peak_a, peak_b),
                activity=self._gyro[finger].peak(t - CONTACT_WINDOW_US, t + CONTACT_WINDOW_US)[0],
                latest_us=to_us,
            )
        return None

    def _toward(self, bit: int, t_us: int) -> np.ndarray | None:
        """Unit vector from the finger's tip toward the thumb's, as they stood at t."""
        if not self._tips:
            return None
        chosen = self._tips[0][1]
        for ts, tips in self._tips:
            if ts > t_us:
                break
            chosen = tips
        d = chosen[0] - chosen[bit + 1]        # thumb is index 0
        n = float(np.linalg.norm(d))
        return d / n if n > 1e-4 else None

    def _closing_before(self, finger: str, toward: np.ndarray, t_us: int) -> float:
        """Leaky-integrated closing speed up to t. Positive means still coming together.

        Integrating acceleration usually drifts. It is safe here because the
        filter zeroes anything inside its deadband, the integrator leaks, and only
        the sign is ever used.
        """
        a, b = self._accel[finger], self._accel["thumb"]
        by_time = dict(zip(b.t, b.a))
        speed = 0.0
        previous: int | None = None
        tau_s = VELOCITY_TAU_US / 1e6
        for i, t in enumerate(a.t):
            if t >= t_us:
                break
            partner = by_time.get(t)
            if partner is None:              # pair by timestamp, never by position
                continue
            closing = float((a.a[i] - partner) @ toward)
            if previous is not None:
                dt = (t - previous) / 1e6
                speed = speed * np.exp(-dt / tau_s) + closing * dt
            previous = t
        return speed

    # ── arbitration ───────────────────────────────────────────────────────────

    def _settle(self, contact: Contact) -> None:
        if self._settling is None:
            self._settling = _Settling(opened_us=contact.t_us)
        s = self._settling
        s.candidates.append(contact)
        # Extended by each arrival, since a collision still producing spikes is
        # still happening; capped, or a hand that never goes quiet holds the
        # decision for ever — and the cap is what keeps deliberate taps separate.
        s.deadline_us = min(
            max(s.deadline_us, contact.t_us + self.SETTLE_WINDOW_US),
            s.opened_us + self.SETTLE_WINDOW_US * self.MAX_SETTLE_WINDOWS,
        )

    def resolve(self, now_us: int) -> list[int]:
        """Whichever collisions have finished gathering rivals. Returns pinch bits."""
        s = self._settling
        if s is None or now_us < s.deadline_us:
            return []
        self._settling = None

        fired: list[int] = []
        remaining = list(s.candidates)
        while remaining:
            # Movement first, force second. A thumb landing on the index also
            # shakes the middle, so several triggers can pass every gate on one
            # physical event; the finger that actually swung is the one whose
            # gyroscope moved. Force only breaks ties, which is what a device
            # publishing no per-site gyroscope falls back to.
            winner = max(remaining, key=lambda c: (c.activity, c.strength))
            rivals = [c for c in remaining if _shares_a_finger(c, winner)]
            remaining = [c for c in remaining if c not in rivals]
            for loser in rivals:
                if loser is not winner:
                    self._scan_from[loser.bit] = loser.latest_us
            if self._commit(winner, s.deadline_us):
                fired.append(winner.bit)
        return fired

    def _commit(self, winner: Contact, settled_us: int) -> bool:
        """Fire, unless a contact on one of the same fingers is still guarded.

        The guard spans the seam between frames, which within-frame arbitration
        cannot see. It runs for at least the rearm cooldown, and that part is
        physical: a finger is one object and can touch one thing at a time, so a
        thumb that has just met the index cannot meet the middle fifty
        milliseconds later, whatever two triggers independently believe.
        """
        guard = max(self.SETTLE_WINDOW_US, REARM_COOLDOWN_US)
        for site in ("thumb", ("index", "middle", "ring", "pinky")[winner.bit]):
            previous = self._last_contact.get(site)
            if previous is None:
                continue
            if winner.t_us < previous:       # a stamp from before a clock restart
                self._last_contact.pop(site, None)
                continue
            if winner.t_us - previous < guard:
                self._scan_from[winner.bit] = winner.latest_us
                return False

        stamp = max(settled_us, winner.t_us)
        self._last_contact["thumb"] = stamp
        self._last_contact[("index", "middle", "ring", "pinky")[winner.bit]] = stamp
        self._scan_from[winner.bit] = winner.t_us + REARM_COOLDOWN_US
        return True


def _shares_a_finger(a: Contact, b: Contact) -> bool:
    """Two pairs with no finger in common are two collisions, not two readings of one."""
    return a.bit == b.bit          # every pinch here shares the thumb
