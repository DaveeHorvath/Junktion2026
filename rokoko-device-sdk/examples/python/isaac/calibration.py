"""The two session-dependent inputs to `frames.HandRebase`: the yaw
offset and the wrist anchor.

Yaw cannot be a constant — the solver's heading is magnetic-north
referenced with an arbitrary per-session zero — so it is captured from
an operator gesture: hold the hand pointing along the workspace's +X
axis (fingers toward +X, hand roughly level) and call
`capture_yaw_offset` with the current frame. Re-capture at will; labs
with large moving metal shift the reference mid-session.

The wrist anchor exists because the OpenXR group is wrist-relative
(the wrist stays at the origin — an articulated hand with no world
position unless a Coil Pro is present upstream). `FixedWristAnchor` is
the first, tabletop-teleop-sized implementation; tracked sources slot
in behind the same `pose(hand)` shape later.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol

from isaac.frames import XR_BASE_TO_Z_UP, Pose, Quat, Vec3, q_mul, q_rotate
from isaac.glove_stream import HandFrame

# OpenXR joint frames put +Z backward along the bone (+Y dorsal), so the
# direction the hand points — wrist toward fingers — is the wrist's −Z.
_WRIST_FORWARD: Vec3 = (0.0, 0.0, -1.0)

# Below this horizontal fraction of the forward vector, heading is
# numerically meaningless (hand pointing straight up or down).
_MIN_HORIZONTAL = 0.2


def normalize_angle(rad: float) -> float:
    """Wrap into (−π, π]."""
    wrapped = math.fmod(rad + math.pi, 2.0 * math.pi)
    if wrapped <= 0.0:
        wrapped += 2.0 * math.pi
    return wrapped - math.pi


def measure_heading(frame: HandFrame) -> float:
    """The hand's current heading in the Z-up frame: the angle of its
    forward direction projected onto the horizontal plane, measured from
    +X toward +Y. Raises ValueError when the hand points too far up or
    down to carry a heading."""
    wrist = next((j for j in frame.joints if j.name == "wrist"), None)
    if wrist is None:
        raise ValueError("frame carries no wrist joint")
    q_zup: Quat = q_mul(XR_BASE_TO_Z_UP, wrist.orientation)
    fx, fy, fz = q_rotate(q_zup, _WRIST_FORWARD)
    if math.hypot(fx, fy) < _MIN_HORIZONTAL:
        raise ValueError(
            "hand is pointing too far up or down to read a heading — "
            "hold it roughly level, fingers toward the workspace +X"
        )
    return math.atan2(fy, fx)


def capture_yaw_offset(frame: HandFrame, facing_yaw_rad: float = 0.0) -> float:
    """The yaw offset that makes the hand in `frame` face `facing_yaw_rad`
    (default: the workspace +X). Feed the result to
    `HandRebase.for_isaac(yaw_rad=...)`. One capture covers both hands —
    the offset corrects the shared magnetic reference, not the hand."""
    return normalize_angle(facing_yaw_rad - measure_heading(frame))


class WristAnchor(Protocol):
    """Where a hand's wrist sits in the Isaac world. Implementations may
    be static or track something; `pose` is read per applied frame."""

    def pose(self, hand: str) -> Pose: ...


@dataclass(frozen=True)
class FixedWristAnchor:
    """Both wrists at fixed workspace poses — sufficient for tabletop
    teleop where gross hand position is not driven by the gloves."""

    left: Pose = Pose()
    right: Pose = Pose()

    def pose(self, hand: str) -> Pose:
        return self.left if hand == "left" else self.right
