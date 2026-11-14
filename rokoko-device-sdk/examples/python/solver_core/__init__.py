"""The Smartgloves hand solver: one frame of sensor state in, a posed 26-joint
hand out.

Layered `math` -> `transform` -> `skeleton` -> `finger_poser`, with
`smartglove` recognizing a glove in an RGMP definition. The names below are
the common path; importing from the module you mean is expected.

Everything runs in the gloves' right-handed sensor frame (+X right, +Y toward
the wrist, +Z down). No handedness conversion happens here.
"""

from __future__ import annotations

from solver_core.finger_poser import (
    GloveState,
    SensorState,
    glove_state_from_sample,
    is_finite_pose,
    solve_fingers,
)
from solver_core.math import Quat, Vec3
from solver_core.skeleton import HandSkeleton, pose_fingers_in_hand
from solver_core.skeleton_data import HandJointData
from solver_core.smartglove import (
    SENSOR_COUNT,
    GloveSample,
    decode_glove_sample,
    find_glove_layout,
    is_smartglove,
)
from solver_core.transform import TransformTree

__all__ = [
    "SENSOR_COUNT",
    "GloveSample",
    "GloveState",
    "HandJointData",
    "HandSkeleton",
    "Quat",
    "SensorState",
    "TransformTree",
    "Vec3",
    "decode_glove_sample",
    "find_glove_layout",
    "glove_state_from_sample",
    "is_finite_pose",
    "is_smartglove",
    "pose_fingers_in_hand",
    "solve_fingers",
]
