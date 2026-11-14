// Pure per-sensor placement, label formatting, and the shared annotation
// colors for the hand rig, kept out of the components so the sensor gizmos,
// EMF halos, OBB boxes, and angle labels share one tested implementation.

import { Bone, type HandSkeleton } from "../solver/hand-skeleton.ts";
import {
  ARM_IN_WORLD_SENSOR_ID,
  ARM_SENSOR_ID,
  HUB_SENSOR_ID,
  isCoilPresent,
  sensorWorldQuat,
  type GloveSample,
} from "../solver/smartglove.ts";
import { DRIVEN_BONES, FINGER_BONE_OFFSET } from "../solver/finger-poser.ts";
import {
  QUAT_IDENTITY,
  qInverse,
  qMul,
  qNormalize,
  vAdd,
  vTransform,
  type Quat,
  type Vec3,
} from "../solver/math.ts";

/** Annotation tone for sensor labels, triad boxes, and angle readouts. */
export const COLOR_MUTED = "#8b93a3";

/** Tint for a sensor whose STATUS_FLAGS report invalid data. */
export const COLOR_INVALID = "#f85149";

/** Whole degrees; `|| 0` folds the "-0" that Math.round leaves on (-0.5, 0). */
export const fmtDeg = (v: number) => String(Math.round(v) || 0);

/** One joint's local euler angles as label text, x y z order (flexion first). */
export function formatAngles(a: Vec3): string {
  return `${fmtDeg(a[0])}° ${fmtDeg(a[1])}° ${fmtDeg(a[2])}°`;
}

/**
 * A sensor's device-frame position on the solved skeleton, or null when it
 * can't be placed. Inverts the solver's mounting relation (see HandRig.tsx's
 * header comment): the sensor sits at bonePos + R·offset for its driven bone,
 * the hub hangs off the hand bone (the one x≠0 offset, hence the mirror sign),
 * and the world-anchored arm passes its streamed Coil Pro position through.
 * `q` is the orientation the offset is rotated by; callers that draw the pose
 * should go through sensorPoseOnSkeleton, which supplies the right one.
 */
export function sensorDevicePosition(
  skel: HandSkeleton,
  sample: GloveSample,
  id: number,
  q: Quat,
  isRight: boolean,
): Vec3 | null {
  if (id < DRIVEN_BONES.length) {
    const bone = skel.sidedBone(DRIVEN_BONES[id]);
    return vAdd(bone.position, vTransform(FINGER_BONE_OFFSET[id], q));
  }
  if (id === ARM_SENSOR_ID) {
    const bone = skel.sidedBone(Bone.LEFT_LOWER_ARM);
    return vAdd(bone.position, vTransform(FINGER_BONE_OFFSET[id], q));
  }
  if (id === HUB_SENSOR_ID) {
    const hand = skel.sidedBone(Bone.LEFT_HAND);
    const off = FINGER_BONE_OFFSET[id];
    const sign = isRight ? 1 : -1;
    return vAdd(hand.position, hand.transformVector([off[0] * sign, off[1], off[2]]));
  }
  if (id === ARM_IN_WORLD_SENSOR_ID) {
    // Only meaningful when the Coil Pro streams a world position.
    return (sample.positions[id] as Vec3 | null) ?? null;
  }
  return null;
}

/**
 * The rotation world anchoring applied to the solved skeleton: identity while
 * no Coil Pro is tracking.
 *
 * Sensor orientations stream in the solver's world, referenced to magnetic
 * north. With a Coil Pro tracking, the solver re-anchors the skeleton's root
 * (the arm bone) so the arm sensor lands on its pose in the Coil Pro frame,
 * which rotates the whole skeleton out of that world — by 33° to 147° on the
 * recordings of HAR-630. Anything drawn from the raw orientations has to be
 * rotated by the same amount to stay on the skeleton.
 *
 * Recovered from the solved skeleton rather than recomputed from the stream, so
 * it is by construction what was applied: the arm bone is set to the arm
 * sensor's world orientation and anchoring rotates it from there. The solver's
 * inputs default to identity when a sensor is missing, and so do these.
 */
export function anchorRotation(skel: HandSkeleton, sample: GloveSample): Quat {
  if (!isCoilPresent(sample, ARM_IN_WORLD_SENSOR_ID)) return QUAT_IDENTITY;
  const hub = sample.quats[HUB_SENSOR_ID] ?? QUAT_IDENTITY;
  const arm = sample.quats[ARM_SENSOR_ID] ?? QUAT_IDENTITY;
  const armBone = skel.sidedBone(Bone.LEFT_LOWER_ARM);
  return qNormalize(qMul(armBone.rotation, qInverse(qMul(hub, arm))));
}

/** A sensor's pose in the frame the solved skeleton is drawn in. */
export interface SensorPose {
  position: Vec3;
  rotation: Quat;
}

/**
 * Where to draw a sensor on the solved skeleton, or null when it can't be
 * placed. The one placement the sensor gizmos, EMF halos and OBB boxes share,
 * so all three agree with each other and with the skeleton.
 *
 * Hub-relative orientations are rotated by `anchor` (see anchorRotation, which
 * the caller computes once per frame) so they stay in the skeleton's frame once
 * a Coil Pro anchors it. The world-anchored arm needs no such rotation: it
 * streams in the Coil Pro frame already, and with the arm sensor rotated the
 * same way the two coincide in orientation. It exists only while a Coil Pro is
 * tracking; without one its stream carries an identity pose at the origin,
 * which is not a pose to draw.
 */
export function sensorPoseOnSkeleton(
  skel: HandSkeleton,
  sample: GloveSample,
  id: number,
  isRight: boolean,
  anchor: Quat,
): SensorPose | null {
  const worldArm = id === ARM_IN_WORLD_SENSOR_ID;
  if (worldArm && !isCoilPresent(sample, id)) return null;
  const q = sensorWorldQuat(sample, id);
  if (q === null) return null;
  const rotation = worldArm ? q : qMul(anchor, q);
  const position = sensorDevicePosition(skel, sample, id, rotation, isRight);
  return position === null ? null : { position, rotation };
}
