"""Frame conversion: the solver's `xr_base` (Y-up) into an Isaac world
(Z-up, right-handed), with the per-session yaw offset and the wrist
anchor composed in.

The solver deliberately emits in the glove's own terms and leaves the
rebase to the consumer: pitch and roll are gravity-referenced, but yaw is
magnetic-north-referenced with an arbitrary per-session zero that no
fixed rotation can cancel. So the conversion here has a fixed part —
one +90° rotation about X, taking `xr_base`'s +Y up to Isaac's +Z up —
and two session parts supplied by `calibration.py`: a yaw offset about
the up axis, and a wrist anchor placing the (wrist-relative) hand in
the workspace.

All of it composes into one rigid transform per hand, applied to all 26
joints:

    p_world = anchor.position + R · p_xr       R = q_anchor ∘ q_yaw ∘ q_base
    q_world = R ∘ q_xr

Pure math on tuples — no numpy, no Isaac imports — so this stays
CI-testable. Quaternions are `(x, y, z, w)`, matching the wire order.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from isaac.glove_stream import HandFrame, JointPose

Vec3 = tuple[float, float, float]
Quat = tuple[float, float, float, float]

QUAT_IDENTITY: Quat = (0.0, 0.0, 0.0, 1.0)
VEC3_ZERO: Vec3 = (0.0, 0.0, 0.0)


def q_from_axis_angle(axis: Vec3, angle_rad: float) -> Quat:
    """Unit quaternion for a rotation of `angle_rad` about `axis`
    (which must be non-zero; it is normalized here)."""
    ax, ay, az = axis
    norm = math.sqrt(ax * ax + ay * ay + az * az)
    if norm == 0.0:
        raise ValueError("rotation axis must be non-zero")
    s = math.sin(angle_rad / 2.0) / norm
    return (ax * s, ay * s, az * s, math.cos(angle_rad / 2.0))


def q_mul(a: Quat, b: Quat) -> Quat:
    """Hamilton product `a ∘ b`: rotating by the result applies `b`
    first, then `a` — `q_rotate(q_mul(a, b), v) == q_rotate(a, q_rotate(b, v))`."""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def q_normalize(q: Quat) -> Quat:
    x, y, z, w = q
    norm = math.sqrt(x * x + y * y + z * z + w * w)
    if norm == 0.0:
        raise ValueError("cannot normalize a zero quaternion")
    return (x / norm, y / norm, z / norm, w / norm)


def q_rotate(q: Quat, v: Vec3) -> Vec3:
    """Rotate `v` by the unit quaternion `q` (v' = q v q*)."""
    qx, qy, qz, qw = q
    vx, vy, vz = v
    # t = 2 * (q.xyz × v); v' = v + w*t + q.xyz × t
    tx = 2.0 * (qy * vz - qz * vy)
    ty = 2.0 * (qz * vx - qx * vz)
    tz = 2.0 * (qx * vy - qy * vx)
    return (
        vx + qw * tx + qy * tz - qz * ty,
        vy + qw * ty + qz * tx - qx * tz,
        vz + qw * tz + qx * ty - qy * tx,
    )


# xr_base is Y-up; Isaac's world is Z-up. +90° about X maps +Y → +Z
# (and +Z → −Y), leaving +X alone.
XR_BASE_TO_Z_UP: Quat = q_from_axis_angle((1.0, 0.0, 0.0), math.pi / 2.0)


@dataclass(frozen=True)
class Pose:
    """A rigid pose: position in meters, orientation as x y z w."""

    position: Vec3 = VEC3_ZERO
    orientation: Quat = QUAT_IDENTITY


@dataclass(frozen=True)
class HandRebase:
    """One hand's precomposed rigid transform out of `xr_base`.

    Built via `for_isaac()`; `apply()` converts a `HandFrame` in place of
    its values — same joints, same names, positions and orientations now
    in the Isaac world.
    """

    rotation: Quat = field(default=QUAT_IDENTITY)
    translation: Vec3 = field(default=VEC3_ZERO)

    @classmethod
    def for_isaac(cls, yaw_rad: float = 0.0, anchor: Pose = Pose()) -> "HandRebase":
        """Compose base swap (Y-up → Z-up), then the session yaw offset
        about the up axis, then the wrist anchor."""
        yaw = q_from_axis_angle((0.0, 0.0, 1.0), yaw_rad)
        rotation = q_mul(anchor.orientation, q_mul(yaw, XR_BASE_TO_Z_UP))
        return cls(rotation=q_normalize(rotation), translation=anchor.position)

    def apply_pose(self, position: Vec3, orientation: Quat) -> tuple[Vec3, Quat]:
        px, py, pz = q_rotate(self.rotation, position)
        tx, ty, tz = self.translation
        return (px + tx, py + ty, pz + tz), q_mul(self.rotation, orientation)

    def apply(self, frame: HandFrame) -> HandFrame:
        joints = []
        for joint in frame.joints:
            position, orientation = self.apply_pose(joint.position, joint.orientation)
            joints.append(JointPose(joint.name, position, orientation))
        return HandFrame(
            device_id=frame.device_id,
            hand=frame.hand,
            timestamp_us=frame.timestamp_us,
            joints=tuple(joints),
        )
