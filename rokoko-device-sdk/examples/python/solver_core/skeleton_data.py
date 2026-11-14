# Skeleton data for the hand solver.

from __future__ import annotations

import json
from pathlib import Path
from typing import NamedTuple

from solver_core.math import Quat, Vec3

# TODO (anastasia): this is a local copy. When a location shared by all
# ports is in place, consume that instead of keeping our own copy here.
_SKELETON_JSON_PATH = Path(__file__).resolve().parent / "data" / "hand-skeleton.json"


class HandJointData(NamedTuple):
    """One joint of the Newton hand skeleton, in glTF order (parents first)."""

    name: str
    bone: int
    parent: int
    local_pos: Vec3
    local_rot: Quat


def _load_hand_joints() -> dict[str, list[HandJointData]]:
    raw = json.loads(_SKELETON_JSON_PATH.read_text())
    return {
        side: [
            HandJointData(
                name=joint["name"],
                bone=joint["bone"],
                parent=joint["parent"],
                local_pos=tuple(joint["localPos"]),
                local_rot=tuple(joint["localRot"]),
            )
            for joint in joints
        ]
        for side, joints in raw.items()
    }


HAND_JOINTS: dict[str, list[HandJointData]] = _load_hand_joints()
