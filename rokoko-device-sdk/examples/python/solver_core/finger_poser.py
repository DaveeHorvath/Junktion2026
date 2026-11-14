"""The Smartgloves finger solver: poses a HandSkeleton from one frame of
sensor quaternions.

Per frame: reset to the default pose, pin the hand root to the hub sensor
(offset by the hub's mounting position on the back of the hand), then for
each finger aim the driven bone's parent at a target position derived from
the sensor orientation and that sensor's mounting offset, constrain
non-thumb fingers to hinge motion, and distribute residual curl to the
distal joint. Finally orient the forearm from the arm sensor (hub-relative)
and, when a Coil Pro is tracking, re-anchor the arm in world space.

All math runs in the gloves' right-handed sensor frame; nothing here does
any handedness conversion.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from solver_core.skeleton import (
    LEFT_HAND,
    LEFT_INDEX_MEDIAL,
    LEFT_LITTLE_MEDIAL,
    LEFT_LOWER_ARM,
    LEFT_MIDDLE_MEDIAL,
    LEFT_RING_MEDIAL,
    LEFT_THUMB_PROXIMAL,
    HandSkeleton,
    pose_fingers_in_hand,
)
from solver_core.math import (
    QUAT_IDENTITY,
    VEC3_UNIT_X,
    VEC3_UNIT_Y,
    VEC3_ZERO,
    Quat,
    Vec3,
    angle_axis,
    euler_vec,
    from_to_rotation,
    inverse_lerp,
    look_rotation,
    q_inverse,
    q_lerp,
    q_mul,
    q_normalize,
    q_project,
    v_add,
    v_neg,
    v_normalize_safe,
    v_sub,
    v_transform,
)
from solver_core.smartglove import (
    ARM_IN_WORLD_SENSOR_ID,
    ARM_SENSOR_ID,
    HUB_SENSOR_ID,
    SENSOR_COUNT,
    THUMB_FINGER_ID,
    GloveSample,
)


@dataclass
class SensorState:
    """One sensor's state, as the solver consumes it."""

    rotation: Quat
    position: Vec3 = VEC3_ZERO  # hub-space; zero for orientation-only streams
    calibration_offset: Vec3 = VEC3_ZERO  # rotation calibration, Euler degrees
    is_coil_present: bool = False  # only meaningful on the arm-in-world sensor


@dataclass
class GloveState:
    """The solver's per-frame input."""

    is_right: bool
    hand_width: float  # knuckle span, meters; 0 keeps the model default
    sensors: list[SensorState | None] = field(
        default_factory=lambda: [None] * SENSOR_COUNT
    )


# The bone each finger's sensor drives: the thumb sensor drives the proximal
# joint (the thumb has no medial), the other sensors drive the medial joint.
DRIVEN_BONES = [
    LEFT_THUMB_PROXIMAL,
    LEFT_INDEX_MEDIAL,
    LEFT_MIDDLE_MEDIAL,
    LEFT_RING_MEDIAL,
    LEFT_LITTLE_MEDIAL,
]

# Sensor mounting offsets relative to the driven bone, in meters, authored
# for the LEFT hand; x sign-flips for the right (the hands are mirror
# images).
FINGER_BONE_OFFSET: list[Vec3] = [
    (0.0, -0.016, -0.0125),  # thumb
    (0.0, -0.015, -0.012),  # index
    (0.0, -0.016, -0.012),  # middle
    (0.0, -0.016, -0.012),  # ring
    (0.0, -0.015, -0.012),  # little
    (0.0, -0.24, -0.023),  # lower arm
    (0.007, -0.05, -0.02),  # hand (hub)
]

NUMBER_OF_FINGERS = 5

# Default hub mounting-angle correction, Euler degrees
HUB_CALIBRATION_OFFSET: Vec3 = (0.0, 5.0, -15.0)


def _sign(x: float) -> float:
    """Matches JS `Math.sign`: -1, 0, or 1 — 0 stays exactly 0, not ±1."""
    if x > 0:
        return 1.0
    if x < 0:
        return -1.0
    return 0.0


def _calibrated_rotation(sensor: SensorState) -> Quat:
    """Sensor orientation with its per-sensor calibration offset applied."""
    return q_mul(sensor.rotation, euler_vec(sensor.calibration_offset))


def _finger_aim(target_direction: Vec3, axis: Vec3) -> Quat:
    """Aim a finger's parent bone at a target, used to orient the finger chain."""
    return q_mul(look_rotation(target_direction, axis), euler_vec((0.0, -90.0, 90.0)))


def solve_fingers(glove: GloveState, skel: HandSkeleton, hinges: bool = True) -> None:
    # ── 1. Rest pose, then the hand root pinned to the hub ─────────────────
    skel.reset_local_transforms()
    pose_fingers_in_hand(skel, glove.hand_width, False)
    skel.propagate()

    hub_sensor = glove.sensors[HUB_SENSOR_ID]
    if hub_sensor is None:
        return
    hand_bone = skel.sided_bone(LEFT_HAND)
    arm_bone = skel.sided_bone(LEFT_LOWER_ARM)

    # This skeleton is rooted at the forearm, so the forearm moves freely
    # with no upper body to detach from.

    sign = 1.0 if glove.is_right else -1.0
    hub_x, hub_y, hub_z = FINGER_BONE_OFFSET[HUB_SENSOR_ID]
    hub_offset: Vec3 = (hub_x * sign, hub_y, hub_z)

    # Rotate the hand bone by the hub mounting-angle correction while
    # keeping the hub sensor itself at the origin, where the finger sensor
    # positions (hub-relative) expect it.
    hub_calibration = euler_vec(hub_sensor.calibration_offset)
    hand_bone.align_root_to(
        v_neg(v_transform(hub_offset, hub_calibration)), hub_calibration
    )

    # ── 2. Each finger, aimed from its own sensor ──────────────────────────
    for i in range(NUMBER_OF_FINGERS):
        sensor = glove.sensors[i]
        if sensor is None:
            continue
        # The thumb is the exception twice below: it has no medial joint, so
        # its sensor drives the proximal, and it is the one finger allowed
        # to bend the way the hinge floor exists to prevent.
        is_thumb = i == THUMB_FINGER_ID
        driven_bone = skel.sided_bone(DRIVEN_BONES[i])
        parent_bone = driven_bone.parent
        distal_bone = driven_bone.children[0]

        bone_rotation = _calibrated_rotation(sensor)
        bone_x_axis = v_transform(VEC3_UNIT_X, bone_rotation)

        sensor_world_position = sensor.position
        target_position = v_add(
            sensor_world_position,
            v_transform(
                v_neg(FINGER_BONE_OFFSET[i]), bone_rotation
            ),  # lossyScale is always 1 here
        )

        parent_rotation = _finger_aim(
            v_sub(target_position, parent_bone.position), bone_x_axis
        )
        local_rotation = q_mul(q_inverse(parent_rotation), bone_rotation)

        # Hinge floor for all fingers but the thumb: when the joint would
        # bend backwards past -10°, push the parent aim back so it doesn't.
        if not is_thumb:
            rotated_y = v_transform(VEC3_UNIT_Y, local_rotation)
            local_axis = v_normalize_safe((0.0, rotated_y[1], rotated_y[2]))
            if local_axis is not None:
                # Clamped: the argument is a normalized component so it's
                # in range mathematically, but rounding can push it a hair past ±1, where acos is NaN
                y = min(max(local_axis[1], -1.0), 1.0)
                local_angle = -_sign(local_axis[2]) * math.degrees(math.acos(y))
                if local_angle < 10:
                    t = inverse_lerp(-10, 10, local_angle)
                    parent_rotation = q_mul(
                        angle_axis(-local_angle + 10 * t, bone_x_axis), parent_rotation
                    )
                    local_rotation = q_mul(q_inverse(parent_rotation), bone_rotation)

        axis_aligned_local_rotation = q_project(local_rotation, VEC3_UNIT_X)
        world_axis_correction = from_to_rotation(
            v_transform(
                VEC3_UNIT_Y, q_mul(parent_rotation, axis_aligned_local_rotation)
            ),
            v_transform(VEC3_UNIT_Y, q_mul(parent_rotation, local_rotation)),
        )

        if not is_thumb and hinges:
            parent_rotation = q_mul(
                q_lerp(QUAT_IDENTITY, world_axis_correction, 0.25), parent_rotation
            )
            local_rotation = axis_aligned_local_rotation

        parent_bone.rotation = parent_rotation
        driven_bone.local_rotation = local_rotation
        # The distal joint isn't driven by its own sensor at all — it gets
        # 2/3 of the (axis-aligned) proximal/medial rotation.
        distal_bone.local_rotation = q_lerp(
            QUAT_IDENTITY, axis_aligned_local_rotation, 2 / 3
        )

        parent_bone.update_child_transforms_recursive()

    # ── 3. The forearm, from the arm sensor ────────────────────────────────
    arm_sensor = glove.sensors[ARM_SENSOR_ID]
    if arm_sensor is None:
        return
    arm_sensor_position = v_transform(arm_sensor.position, hub_sensor.rotation)
    arm_sensor_orientation = q_mul(hub_sensor.rotation, arm_sensor.rotation)

    # The arm follows the raw hub frame; only the hand gets the mounting
    # correction, which is what puts the ~16° bias at the wrist.
    arm_bone.rotation = arm_sensor_orientation
    hand_bone.rotation = q_mul(hub_sensor.rotation, hub_calibration)
    arm_bone.update_child_transforms_recursive()

    hand_bone.align_root_to(VEC3_ZERO, q_mul(hub_sensor.rotation, hub_calibration))
    hand_bone.parent.update_child_transforms_recursive()

    hub_world_pos = v_add(hand_bone.position, hand_bone.transform_vector(hub_offset))
    arm_sensor_position = v_add(arm_sensor_position, hub_world_pos)

    # ── 4. World anchoring, when a Coil Pro is tracking ────────────────────
    coil_sensor = glove.sensors[ARM_IN_WORLD_SENSOR_ID]
    if coil_sensor is None or not coil_sensor.is_coil_present:
        return

    # World-anchoring alignment, as separate rotation/translation deltas.
    rot_delta = q_normalize(
        q_mul(coil_sensor.rotation, q_inverse(arm_sensor_orientation))
    )
    pos_delta = v_sub(coil_sensor.position, v_transform(arm_sensor_position, rot_delta))
    arm_bone.apply_alignment(rot_delta, pos_delta)
    # Re-propagate from the arm's parent, falling back to the arm itself
    # since it is the skeleton root.
    (arm_bone.parent or arm_bone).update_child_transforms_recursive()


def glove_state_from_sample(
    sample: GloveSample, is_right: bool, hand_width: float = 0.0
) -> GloveState:
    """GloveState from a decoded frame sample. Every sensor exists with
    identity/zero defaults, streamed data overrides it — a sensor missing
    from one frame degrades gracefully instead of dropping the solve."""
    sign = 1.0 if is_right else -1.0
    sensors: list[SensorState] = []
    for sensor_id in range(SENSOR_COUNT):
        rotation = sample.quats[sensor_id] or QUAT_IDENTITY
        position = sample.positions[sensor_id] or VEC3_ZERO
        if sensor_id == HUB_SENSOR_ID:
            calibration_offset = (
                HUB_CALIBRATION_OFFSET[0],
                HUB_CALIBRATION_OFFSET[1] * sign,
                HUB_CALIBRATION_OFFSET[2] * sign,
            )
        else:
            calibration_offset = VEC3_ZERO
        sensors.append(
            SensorState(
                rotation=rotation,
                position=position,
                calibration_offset=calibration_offset,
                is_coil_present=sample.is_coil_present(sensor_id),
            )
        )
    return GloveState(is_right=is_right, hand_width=hand_width, sensors=sensors)


def is_finite_pose(skel: HandSkeleton) -> bool:
    return all(
        math.isfinite(c)
        for node in skel.nodes
        for c in (*node.position, *node.rotation)
    )
