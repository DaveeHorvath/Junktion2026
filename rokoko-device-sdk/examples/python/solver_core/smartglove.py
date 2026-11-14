"""Decodes a smart glove's sensor data.

`find_glove_layout` builds a per-definition layout just for glove sensors,
using the wire primitives from `rgmp_core.layout` — so `decode_glove_sample`
can go straight from a Data frame's raw payload to a `GloveSample`.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

from solver_core.math import Quat, Vec3
from rgmp_core.definition import device_info_bool, device_info_str, device_type_contains
from rgmp_core.layout import StreamSlot, parse_data_type, read_slot, stream_label


class GloveDecodeError(Exception):
    """Raised by `find_glove_layout` for a stream whose `data_type` it cannot
    lay out, and by `decode_glove_sample` for a payload too short for its
    layout."""


# Sensor ids (index into the per-sensor arrays throughout the solver)
THUMB_FINGER_ID = 0
INDEX_FINGER_ID = 1
MIDDLE_FINGER_ID = 2
RING_FINGER_ID = 3
LITTLE_FINGER_ID = 4
ARM_SENSOR_ID = 5
HUB_SENSOR_ID = 6
ARM_IN_WORLD_SENSOR_ID = 7
SENSOR_COUNT = 8

_IS_COIL_PRESENT_BIT = 1 << 9


def is_smartglove(definition: dict) -> bool:
    return device_type_contains(definition, "smartglove")


def detect_is_right(definition: dict) -> bool:
    hand = device_info_str(definition, "hand")
    if hand is not None:
        if hand.lower() == "right":
            return True
        if hand.lower() == "left":
            return False
    return device_info_bool(definition, "is_right_glove") is True


def resolve_sensor_id(
    target_frame: str, reference_frame: str | None = None
) -> int | None:
    """Which sensor a stream's `target_frame` belongs to, or None.

    A sensor and the IMU inside it are one sensor: a glove names them
    `<part>_sensor` and `<part>_imu`, and both resolve to the same id. Which
    measure is being read is what tells them apart, not the frame.
    """
    target = target_frame.lower()
    if "thumb_finger" in target:
        return THUMB_FINGER_ID
    if "index_finger" in target:
        return INDEX_FINGER_ID
    if "middle_finger" in target:
        return MIDDLE_FINGER_ID
    if "ring_finger" in target:
        return RING_FINGER_ID
    if "little_finger" in target:
        return LITTLE_FINGER_ID
    if "arm_sensor" in target or target in ("arm", "arm_imu"):
        reference = (reference_frame or "").lower()
        return ARM_IN_WORLD_SENSOR_ID if "coil_pro" in reference else ARM_SENSOR_ID
    if target in ("hub", "hub_imu"):
        return HUB_SENSOR_ID
    return None


@dataclass
class SensorSlots:
    orientation: StreamSlot | None = None
    transform: StreamSlot | None = None
    status_flags: StreamSlot | None = None


@dataclass
class GloveSample:
    """One frame's worth of glove sensor state, indexed by sensor id."""

    quats: list[Quat | None] = field(default_factory=lambda: [None] * SENSOR_COUNT)
    positions: list[Vec3 | None] = field(default_factory=lambda: [None] * SENSOR_COUNT)
    flags: list[int | None] = field(default_factory=lambda: [None] * SENSOR_COUNT)

    def is_coil_present(self, sensor_id: int) -> bool:
        f = self.flags[sensor_id]
        return f is not None and (f & _IS_COIL_PRESENT_BIT) != 0


def find_glove_layout(definition: dict) -> tuple[int, dict[int, SensorSlots]] | None:
    """The group carrying a `hub` stream, else the first with any
    orientation data. Raises `GloveDecodeError` for a bad `data_type`."""
    fallback: tuple[int, dict[int, SensorSlots]] | None = None
    for group_id, group in enumerate(definition.get("groups", [])):
        offset = 0
        slots: dict[int, SensorSlots] = {}
        has_orientation_like = False
        name = group.get("name", "")
        for entry in group.get("streams", []):
            try:
                base, count, size = parse_data_type(str(entry["data_type"]))
            except KeyError:
                raise GloveDecodeError(
                    f"group {group_id} ({name}) stream {stream_label(entry)}: no data_type"
                ) from None
            except ValueError as e:
                raise GloveDecodeError(
                    f"group {group_id} ({name}) stream {stream_label(entry)}: {e}"
                ) from e
            slot = StreamSlot(offset, base, count)
            offset += size

            sensor_id = resolve_sensor_id(
                str(entry.get("target_frame", "")), entry.get("reference_frame")
            )
            if sensor_id is None:
                continue
            sensor_slots = slots.setdefault(sensor_id, SensorSlots())
            measure = entry.get("measure_type")
            if measure == "ORIENTATION":
                sensor_slots.orientation = slot
                has_orientation_like = True
            elif measure == "TRANSFORM":
                sensor_slots.transform = slot
                has_orientation_like = True
            elif measure == "STATUS_FLAGS":
                sensor_slots.status_flags = slot

        # Telemetry-only groups (flags, no pose) are not candidates.
        if not has_orientation_like:
            continue
        if HUB_SENSOR_ID in slots:
            return group_id, slots
        if fallback is None:
            fallback = (group_id, slots)

    return fallback


def decode_glove_sample(payload: bytes, slots: dict[int, SensorSlots]) -> GloveSample:
    """Decode one Data frame's payload against a layout from
    `find_glove_layout`. Raises `GloveDecodeError` for a too-short payload."""
    sample = GloveSample()
    try:
        for sensor_id, sensor_slots in slots.items():
            if sensor_slots.orientation is not None:
                x, y, z, w = read_slot(sensor_slots.orientation, payload)
                sample.quats[sensor_id] = (x, y, z, w)
            if sensor_slots.transform is not None:
                px, py, pz, qx, qy, qz, qw = read_slot(sensor_slots.transform, payload)
                sample.positions[sensor_id] = (px, py, pz)
                sample.quats[sensor_id] = (qx, qy, qz, qw)
            if sensor_slots.status_flags is not None:
                (flags,) = read_slot(sensor_slots.status_flags, payload)
                sample.flags[sensor_id] = int(flags)
    except struct.error as exc:
        raise GloveDecodeError(f"payload too short ({len(payload)} bytes): {exc}") from exc
    return sample
