"""Turn an RGMP v2 Smartgloves stream into one frame per hand.

Everything above this module works in the hub frame: the back of the hand, with
-Y along the fingers, +Z out of the palm and +Y toward the wrist. The gloves
publish finger transforms already referenced to the hub, so this mostly locates
streams and unpacks them — the exception is the IMUs, which each report in their
own sensor frame and are rotated into the hub's here.

Nothing here knows the wire format. Offsets come from ``rgmp_core.StreamLayout``,
values from ``rgmp_core.read_slot``, and which sensor a stream belongs to from
``solver_core.smartglove.resolve_sensor_id`` — so a device that adds, drops or
reorders a stream moves every offset after it without this module being told.
Only the site names and the choice of group are ours.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy.spatial.transform import Rotation

from rgmp_core.layout import StreamLayout, StreamSlot, read_slot
from solver_core.smartglove import (
    ARM_SENSOR_ID,
    HUB_SENSOR_ID,
    INDEX_FINGER_ID,
    LITTLE_FINGER_ID,
    MIDDLE_FINGER_ID,
    RING_FINGER_ID,
    THUMB_FINGER_ID,
    detect_is_right,
    resolve_sensor_id,
)

# The IMU sites, in a fixed order so a frame's per-site arrays can be indexed by
# site rather than by name.
SITES = ("hub", "thumb", "index", "middle", "ring", "pinky", "arm")
SITE_INDEX = {name: i for i, name in enumerate(SITES)}

FINGERS = ("thumb", "index", "middle", "ring", "pinky")

# solver_core numbers the sensors; this program names them. The one disagreement
# is the pinky, which the wire and the solver both call 'little'.
_SITE_OF_SENSOR = {
    THUMB_FINGER_ID: "thumb",
    INDEX_FINGER_ID: "index",
    MIDDLE_FINGER_ID: "middle",
    RING_FINGER_ID: "ring",
    LITTLE_FINGER_ID: "pinky",
    ARM_SENSOR_ID: "arm",
    HUB_SENSOR_ID: "hub",
}


def _site_of(target: str, reference: str | None) -> str | None:
    """Which of `SITES` a stream belongs to, or None if it is not one of ours.

    `resolve_sensor_id` carries the rules worth sharing — that a sensor and the
    IMU inside it are one sensor, and that an arm transform referenced to
    `coil_pro` is a world position rather than the hand's attitude, and so is a
    different one.
    """
    sensor_id = resolve_sensor_id(target, reference)
    return _SITE_OF_SENSOR.get(sensor_id) if sensor_id is not None else None


@dataclass(frozen=True)
class HandFrame:
    """One glove at one instant, in the hub frame."""

    hand: str                 # "left" or "right"
    t_us: int                 # sensor clock, microseconds since device boot

    hand_rotation: Rotation   # arm sensor, hub-relative
    hub_world: Rotation | None  # hub attitude in LTP_NED, when published

    finger_pos: np.ndarray    # (5, 3) sensor positions, FINGERS order
    finger_rot: Rotation      # (5,) sensor rotations, FINGERS order

    site_accel: np.ndarray    # (7, 3) proper acceleration in g, SITES order
    site_gyro: np.ndarray     # (7, 3) angular velocity in rad/s, SITES order


class Unreadable(ValueError):
    """A glove this example will not decode, and why.

    Refusing is the whole point rather than a failure to cope: a stream on the
    wrong protocol version decodes perfectly and only the timing comes out
    wrong, so there is no later opportunity to notice. Raised rather than
    warned so it cannot be read past by accident — it is for the caller to
    decide whether to abandon the session or carry on without this device.
    """


class GloveLayout:
    """Where each value this program needs sits in one device's data frame.

    Built once per Stream Definition Frame. A device that does not publish a
    stream simply leaves its slot ``None``, and the frame carries zeros there.
    """

    def __init__(
        self, definition: dict[str, Any], layout: StreamLayout | None = None
    ) -> None:
        """*layout* is the one `RgmpClient` already built for this definition;
        it is derived here when called without one."""
        version = str(definition.get("protocol_version", ""))
        if not version.startswith("2."):
            # Named as the driver's doing, because it is: the version is the
            # format the driver publishes in, not a property of the glove. Say
            # so, or the obvious move is to unplug the glove and try again,
            # which cannot possibly help.
            raise Unreadable(
                f"this example reads RGMP 2.x only, and the stream declared {version!r}.\n\n"
                "That version is the driver's output format, not anything about this\n"
                "glove. Every device it publishes will say the same, and reconnecting\n"
                "the glove will not change it -- the driver itself has to be restarted,\n"
                "without --pipeline-formatter rgmp-v3. Plain `rgmp` is the default and\n"
                "is 2.x.\n\n"
                "It is refused rather than read because the mistake would be silent: a\n"
                "3.0.0 data frame is byte-identical to a 2.0.0 one, and its third u64\n"
                "counts frames where 2.0.0 carries a capture timestamp. Every frame\n"
                "would decode, and every timing window would quietly become a count of\n"
                "frames."
            )

        self.hand = "right" if detect_is_right(definition) else "left"
        self.device_id = definition.get("device_id")

        self.group_id: int | None = None
        self.hub_world_slot: StreamSlot | None = None
        self.arm_slot: StreamSlot | None = None
        self.finger_slots: dict[str, StreamSlot] = {}
        self.accel_slots: dict[str, StreamSlot] = {}
        self.gyro_slots: dict[str, StreamSlot] = {}

        # The pinch needs the group carrying the finger IMUs. Devices publish
        # several groups — an EMF-only one here — so pick by content rather than
        # by name or by index.
        if layout is None:
            layout = StreamLayout.from_definition(definition)
        for gid, slots in layout.groups.items():
            if self._scan(slots):
                self.group_id = gid
                break
        if self.group_id is None:
            raise Unreadable(
                f"device {self.device_id} publishes no group with per-finger IMUs, "
                "so there is nothing here a pinch could be detected from"
            )

    def _scan(self, slots: list[StreamSlot]) -> bool:
        hub_world = arm = None
        fingers: dict[str, StreamSlot] = {}
        accel: dict[str, StreamSlot] = {}
        gyro: dict[str, StreamSlot] = {}

        for slot in slots:
            s = slot.entry or {}
            measure = s.get("measure_type")
            target = str(s.get("target_frame") or "")
            ref = s.get("reference_frame")
            site = _site_of(target, ref)
            if site is None:
                continue

            if measure == "TRANSFORM" and ref == "hub":
                if site in FINGERS:
                    fingers[site] = slot
                elif site == "arm":
                    arm = slot
            elif measure == "ORIENTATION" and site == "hub":
                hub_world = slot
            elif measure == "PROPER_ACCELERATION":
                accel[site] = slot
            elif measure == "ANGULAR_VELOCITY":
                gyro[site] = slot

        if not all(f in fingers for f in FINGERS) or not accel:
            return False

        self.hub_world_slot = hub_world
        self.arm_slot = arm
        self.finger_slots = fingers
        self.accel_slots = accel
        self.gyro_slots = gyro
        return True

    # ── decode ────────────────────────────────────────────────────────────────

    def frame(self, payload: bytes, t_us: int) -> HandFrame:
        """One data-frame payload for this device's chosen group.

        *t_us* comes from the Data Frame header, which is where 2.0.0 keeps the
        capture time, in the epoch the definition names.
        """
        pos = np.zeros((5, 3), dtype=np.float64)
        quat = np.zeros((5, 4), dtype=np.float64)
        quat[:, 3] = 1.0
        for i, finger in enumerate(FINGERS):
            values = read_slot(self.finger_slots[finger], payload)
            pos[i] = values[:3]
            quat[i] = values[3:7]

        accel = np.zeros((len(SITES), 3), dtype=np.float64)
        gyro = np.zeros((len(SITES), 3), dtype=np.float64)
        for name, slot in self.accel_slots.items():
            accel[SITE_INDEX[name]] = read_slot(slot, payload)
        for name, slot in self.gyro_slots.items():
            gyro[SITE_INDEX[name]] = read_slot(slot, payload)

        hand_rot = Rotation.identity()
        if self.arm_slot is not None:
            hand_rot = _rotation(read_slot(self.arm_slot, payload)[3:7])

        hub_world = None
        if self.hub_world_slot is not None:
            hub_world = _rotation(read_slot(self.hub_world_slot, payload))

        return HandFrame(
            hand=self.hand,
            t_us=t_us,
            hand_rotation=hand_rot,
            hub_world=hub_world,
            finger_pos=pos,
            finger_rot=_rotation(quat),
            site_accel=accel,
            site_gyro=gyro,
        )


# A TRANSFORM is FLOAT[7]: position xyz then quaternion xyzw. Scalar-last is what
# SciPy's Rotation expects, so the components pass straight through.

def _rotation(quat) -> Rotation:
    """A rotation from xyzw, tolerating the zero quaternion a silent sensor sends."""
    q = np.atleast_2d(np.asarray(quat, dtype=np.float64))
    norms = np.linalg.norm(q, axis=1)
    dead = norms < 1e-8
    if dead.any():
        q = q.copy()
        q[dead] = (0.0, 0.0, 0.0, 1.0)
    rot = Rotation.from_quat(q)
    return rot[0] if np.ndim(quat) == 1 else rot
