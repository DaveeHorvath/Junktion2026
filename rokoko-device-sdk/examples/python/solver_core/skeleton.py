"""The hand skeleton and its default (rest) pose.

The skeleton is the forearm sub-branch of the body model: forearm -> hand ->
five fingers (thumb: metacarpal/proximal/distal; the others add a medial
joint), with T-pose local transforms loaded from skeleton_data.py. Each
joint carries a numeric bone id; the ids are laid out so that for any
left-side bone, `id + 1` is the matching right-side bone, which sided_bone()
exploits to resolve a left-named bone to whichever side this skeleton is.
"""

from __future__ import annotations

from solver_core.math import (
    QUAT_IDENTITY,
    Quat,
    Vec3,
    angle_axis,
    euler_vec,
    look_rotation,
    q_mul,
    v_cross,
    v_transform,
)
from solver_core.skeleton_data import HAND_JOINTS
from solver_core.transform import TransformTree

# Bone ids for the hand skeleton (left-side names; right is `id + 1`).
NONE = -1
LEFT_LOWER_ARM = 19
RIGHT_LOWER_ARM = 20
LEFT_HAND = 21
RIGHT_HAND = 22
LEFT_THUMB_METACARPAL = 23
LEFT_THUMB_PROXIMAL = 25
LEFT_THUMB_DISTAL = 27
LEFT_INDEX_METACARPAL = 29
LEFT_INDEX_PROXIMAL = 31
LEFT_INDEX_MEDIAL = 33
LEFT_INDEX_DISTAL = 35
LEFT_MIDDLE_METACARPAL = 37
LEFT_MIDDLE_PROXIMAL = 39
LEFT_MIDDLE_MEDIAL = 41
LEFT_MIDDLE_DISTAL = 43
LEFT_RING_METACARPAL = 45
LEFT_RING_PROXIMAL = 47
LEFT_RING_MEDIAL = 49
LEFT_RING_DISTAL = 51
LEFT_LITTLE_METACARPAL = 53
LEFT_LITTLE_PROXIMAL = 55
LEFT_LITTLE_MEDIAL = 57
LEFT_LITTLE_DISTAL = 59


class HandSkeleton:
    def __init__(self, side: str) -> None:
        self.side = side
        self.is_right = side == "right"
        self.joints = HAND_JOINTS[side]

        nodes = [TransformTree(j.name) for j in self.joints]
        for i, j in enumerate(self.joints):
            if j.parent >= 0:
                nodes[i].parent = nodes[j.parent]
                nodes[j.parent].children.append(nodes[i])
            nodes[i]._local_position = j.local_pos
            nodes[i]._local_rotation = j.local_rot
        TransformTree.propagate_world_transforms(nodes)
        self.nodes = nodes

        self._bone_map: dict[int, TransformTree] = {}
        for i, j in enumerate(self.joints):
            if j.bone >= 0:
                self._bone_map[j.bone] = nodes[i]

    def bone(self, bone_id: int) -> TransformTree:
        node = self._bone_map.get(bone_id)
        if node is None:
            raise KeyError(f"Bone {bone_id} not present in {self.side} hand skeleton")
        return node

    def sided_bone(self, left_bone_id: int) -> TransformTree:
        """Resolve a LEFT_* bone id to this skeleton's side: left ids pass
        through, right ids are the left id + 1."""
        return self.bone(left_bone_id + (1 if self.is_right else 0))

    def propagate(self) -> None:
        """Re-run FK for the whole skeleton after local-rotation edits."""
        TransformTree.propagate_world_transforms(self.nodes)

    def reset_local_transforms(self) -> None:
        for i, j in enumerate(self.joints):
            self.nodes[i].local_position = j.local_pos
            self.nodes[i].local_rotation = j.local_rot


# ── Default pose ─────────────────────────────────────────────────────────────

# Model constant: distance between knuckle joints in the Newton mesh.
_NEWTON_HAND_WIDTH = 0.0565


def azimuth_vector_to_rotation(vector: Vec3) -> Quat:
    """Pose a finger bone from an (azimuth-x, azimuth-y, roll) triple in
    degrees: azimuth-x/y swing the bone away from its rest direction, roll
    twists it about its own length."""
    forward: Vec3 = (0.0, -1.0, 0.0)
    space = look_rotation((0.0, -1.0, 0.0), (-1.0, 0.0, 0.0))
    axis = v_cross(forward, v_transform((vector[0], vector[1], 0.0), space))
    deg = (vector[0] ** 2 + vector[1] ** 2) ** 0.5
    roll: Vec3 = (0.0, -vector[2], 0.0)
    return q_mul(angle_axis(deg, axis), euler_vec(roll))


def _set_sided_rotation(skel: HandSkeleton, left_bone_id: int, azimuth: Vec3) -> None:
    # Angles are authored for the right hand; a left hand mirrors them
    # (azimuth-y and roll flip sign) — anatomy, not a coordinate convention.
    v = azimuth if skel.is_right else (azimuth[0], -azimuth[1], -azimuth[2])
    skel.sided_bone(left_bone_id).local_rotation = azimuth_vector_to_rotation(v)


def pose_fingers_in_hand(
    skel: HandSkeleton, width: float = 0.0, only_metacarpals: bool = False
) -> None:
    """Reset the hand to the neutral pose the solver starts from each
    frame: metacarpals fanned outward, every other finger joint at
    identity. `width` (meters, knuckle span) widens the fan; 0 keeps the
    model default."""
    finger_angle_spacing = 10.0
    if width > 0:
        finger_angle_spacing = (width / _NEWTON_HAND_WIDTH) * finger_angle_spacing

    skel.sided_bone(LEFT_HAND).local_rotation = QUAT_IDENTITY
    _set_sided_rotation(skel, LEFT_THUMB_METACARPAL, (30.0, 30.0, -90.0))
    _set_sided_rotation(skel, LEFT_INDEX_METACARPAL, (0.0, finger_angle_spacing, -1.25))
    _set_sided_rotation(skel, LEFT_MIDDLE_METACARPAL, (0.0, 0.0, 0.0))
    _set_sided_rotation(skel, LEFT_RING_METACARPAL, (3.0, -finger_angle_spacing, 2.5))
    _set_sided_rotation(
        skel, LEFT_LITTLE_METACARPAL, (7.0, -finger_angle_spacing * 2, 5.0)
    )

    if only_metacarpals:
        return

    zero = [
        LEFT_THUMB_PROXIMAL,
        LEFT_INDEX_PROXIMAL,
        LEFT_MIDDLE_PROXIMAL,
        LEFT_RING_PROXIMAL,
        LEFT_LITTLE_PROXIMAL,
        LEFT_INDEX_MEDIAL,
        LEFT_MIDDLE_MEDIAL,
        LEFT_RING_MEDIAL,
        LEFT_LITTLE_MEDIAL,
        LEFT_THUMB_DISTAL,
        LEFT_INDEX_DISTAL,
        LEFT_MIDDLE_DISTAL,
        LEFT_RING_DISTAL,
        LEFT_LITTLE_DISTAL,
    ]
    for b in zero:
        skel.sided_bone(b).local_rotation = QUAT_IDENTITY
