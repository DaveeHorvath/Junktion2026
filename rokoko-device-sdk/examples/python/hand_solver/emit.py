"""Describing and encoding a solved hand as an RGMP v2 device."""

from __future__ import annotations

import enum
from dataclasses import dataclass

from rgmp_core.definition import GroupEntry, StreamDefinition, StreamEntry
from rgmp_core.frame import pack_data_frame, pack_quat, pack_transform
from solver_core.skeleton import HandSkeleton
from solver_core.skeleton_data import HandJointData

SOLVED_DEVICE_TYPE = "solved_hand"
WORLD_FRAME = "LTP_NED"
LOCAL_GROUP_NAME = "joints_local"
WORLD_GROUP_NAME = "joints_world"

SOLVER_NAME = "rgmp_hand_solver.py"
SOLVER_VERSION = "0.1.0"


class Emit(enum.Enum):
    LOCAL = "local"
    WORLD = "world"
    BOTH = "both"

    @classmethod
    def parse(cls, text: str) -> "Emit":
        try:
            return cls(text.lower())
        except ValueError:
            raise ValueError(
                f"unknown --emit value {text!r} (expected local, world, or both)"
            ) from None

    def has_local(self) -> bool:
        return self in (Emit.LOCAL, Emit.BOTH)

    def has_world(self) -> bool:
        return self in (Emit.WORLD, Emit.BOTH)

    def __str__(self) -> str:
        return self.value


def frame_name(joint_name: str) -> str:
    """`LeftFinger5Metacarpal` -> `left_finger5_metacarpal`."""
    out: list[str] = []
    prev_boundary = False
    for c in joint_name:
        if c.isupper() and prev_boundary:
            out.append("_")
        prev_boundary = c.islower() or c.isdigit()
        out.append(c.lower())
    return "".join(out)


@dataclass
class _JointFrame:
    frame: str
    parent_frame: str | None  # None for the root


def _local_streams(frames: list[_JointFrame]) -> list[StreamEntry]:
    root, *rest = frames
    streams: list[StreamEntry] = [
        {
            "data_type": "FLOAT[7]",
            "measure_type": "TRANSFORM",
            "target_frame": root.frame,
            "reference_frame": WORLD_FRAME,
        }
    ]
    for f in rest:
        entry: StreamEntry = {
            "data_type": "FLOAT[4]",
            "measure_type": "ORIENTATION",
            "target_frame": f.frame,
        }
        if f.parent_frame is not None:
            entry["reference_frame"] = f.parent_frame
        streams.append(entry)
    return streams


def _world_streams(frames: list[_JointFrame]) -> list[StreamEntry]:
    return [
        {
            "data_type": "FLOAT[7]",
            "measure_type": "TRANSFORM",
            "target_frame": f.frame,
            "reference_frame": WORLD_FRAME,
        }
        for f in frames
    ]


def _rest_entry(joint: HandJointData, f: _JointFrame) -> StreamEntry:
    entry: StreamEntry = {
        "data_type": "FLOAT[7]",
        "measure_type": "TRANSFORM",
        "target_frame": f.frame,
        "value": [*joint.local_pos, *joint.local_rot],
    }
    if f.parent_frame is not None:
        entry["reference_frame"] = f.parent_frame
    return entry


class HandEmitter:
    """Stream definition + per-frame data frames for one solved hand."""

    def __init__(
        self,
        source: StreamDefinition,
        skel: HandSkeleton,
        emit: Emit = Emit.LOCAL,
        expected_rate_hz: float = 83.3,
    ) -> None:
        self.device_id = int(source["device_id"])
        frames = [
            _JointFrame(
                frame=frame_name(joint.name),
                parent_frame=(
                    frame_name(skel.joints[joint.parent].name)
                    if joint.parent >= 0
                    else None
                ),
            )
            for joint in skel.joints
        ]

        definition: StreamDefinition = {
            "protocol_name": "RGMP",
            "protocol_version": "2.0.0",
            "device_id": self.device_id,
            "device_type": SOLVED_DEVICE_TYPE,
        }
        timestamp_epoch = source.get("timestamp_epoch")
        if timestamp_epoch is not None:
            definition["timestamp_epoch"] = timestamp_epoch

        definition["device_info"] = {
            "hand": skel.side,
            "source_device_id": self.device_id,
            "source_device_type": source.get("device_type"),
            "solver": SOLVER_NAME,
            "solver_version": SOLVER_VERSION,
            "joints": [
                {
                    "frame": f.frame,
                    "name": joint.name,
                    "parent": f.parent_frame,
                    "bone": joint.bone,
                }
                for joint, f in zip(skel.joints, frames)
            ],
        }

        definition["static_data"] = [
            _rest_entry(joint, f) for joint, f in zip(skel.joints, frames)
        ]

        groups: list[GroupEntry] = []
        self._local_group: int | None = None
        self._world_group: int | None = None
        if emit.has_local():
            self._local_group = len(groups)
            groups.append(
                {
                    "name": LOCAL_GROUP_NAME,
                    "expected_rate_hz": expected_rate_hz,
                    "streams": _local_streams(frames),
                }
            )
        if emit.has_world():
            self._world_group = len(groups)
            groups.append(
                {
                    "name": WORLD_GROUP_NAME,
                    "expected_rate_hz": expected_rate_hz,
                    "streams": _world_streams(frames),
                }
            )
        definition["groups"] = groups

        self.definition: StreamDefinition = definition

    def encode(self, skel: HandSkeleton, timestamp_us: int) -> list[bytes]:
        """One payload per emitted group. Value order must match
        `_local_streams`/`_world_streams` exactly."""
        out: list[bytes] = []
        nodes = skel.nodes

        if self._local_group is not None:
            payload = bytearray(pack_transform(nodes[0].position, nodes[0].rotation))
            for node in nodes[1:]:
                payload += pack_quat(node.local_rotation)
            out.append(pack_data_frame(self.device_id, self._local_group, timestamp_us, bytes(payload)))

        if self._world_group is not None:
            payload = bytearray()
            for node in nodes:
                payload += pack_transform(node.position, node.rotation)
            out.append(pack_data_frame(self.device_id, self._world_group, timestamp_us, bytes(payload)))

        return out
