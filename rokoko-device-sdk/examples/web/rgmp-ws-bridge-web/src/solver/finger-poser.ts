// The Smartgloves finger solver: poses a HandSkeleton from one frame of sensor
// quaternions.
//
// Per frame: reset to the default pose, pin the hand root to the hub sensor
// (offset by the hub's mounting position on the back of the hand), then for
// each finger aim the driven bone's parent at a target position derived from
// the sensor orientation and that sensor's mounting offset, constrain
// non-thumb fingers to hinge motion, and distribute residual curl to the
// distal joint. Finally orient the forearm from the arm sensor (hub-relative)
// and, when a Coil Pro is tracking, re-anchor the arm in world space.
//
// All math runs in the gloves' right-handed sensor frame (see math.ts
// for the conventions); the conversion to three.js is a single rotation
// applied at the render boundary, not anything this solver does.

import { Bone, HandSkeleton, poseFingersInHand } from "./hand-skeleton.ts";
import {
  ARM_SENSOR_ID,
  ARM_IN_WORLD_SENSOR_ID,
  HUB_SENSOR_ID,
  SENSOR_COUNT,
  THUMB_FINGER_ID,
  isCoilPresent,
  type GloveSample,
} from "./smartglove.ts";
import {
  QUAT_IDENTITY,
  RAD2DEG,
  VEC3_UNIT_X,
  VEC3_UNIT_Y,
  VEC3_ZERO,
  angleAxis,
  eulerVec,
  fromToRotation,
  inverseLerp,
  lookRotation,
  qInverse,
  qLerp,
  qMul,
  qNormalize,
  qProject,
  vAdd,
  vNeg,
  vNormalizeSafe,
  vScale,
  vSub,
  vTransform,
  type Quat,
  type Vec3,
} from "./math.ts";

/** One sensor's state, as the solver consumes it. */
export interface SensorState {
  /** Sensor-fused orientation. */
  rotation: Quat;
  /** Hub-space position; zero for orientation-only streams. */
  position: Vec3;
  /** Rotation calibration, Euler degrees. */
  calibrationOffset: Vec3;
  /** Coil Pro tracking available (only meaningful on the arm-in-world sensor). */
  isCoilPresent: boolean;
}

/** The solver's per-frame input. */
export interface GloveState {
  isRight: boolean;
  /** Knuckle span in meters; 0 keeps the model default. */
  handWidth: number;
  /** Indexed by sensor id 0..7; null when the sensor isn't streaming. */
  sensors: (SensorState | null)[];
}

// The bone each finger's sensor drives: the thumb sensor drives the proximal
// joint (the thumb has no medial), the other sensors drive the medial joint.
export const DRIVEN_BONES = [
  Bone.LEFT_THUMB_PROXIMAL,
  Bone.LEFT_INDEX_MEDIAL,
  Bone.LEFT_MIDDLE_MEDIAL,
  Bone.LEFT_RING_MEDIAL,
  Bone.LEFT_LITTLE_MEDIAL,
] as const;

// Sensor mounting offsets relative to the driven bone, in meters, authored for
// the LEFT hand; x sign-flips for the right (the hands are mirror images).
// Exported for placing sensor gizmos on the solved hand.
export const FINGER_BONE_OFFSET: readonly Vec3[] = [
  [0, -0.016, -0.0125], // thumb
  [0, -0.015, -0.012], // index
  [0, -0.016, -0.012], // middle
  [0, -0.016, -0.012], // ring
  [0, -0.015, -0.012], // little
  [0, -0.24, -0.023], // lower arm
  [0.007, -0.05, -0.02], // hand (hub)
];

const NUMBER_OF_FINGERS = 5;

// Default hub mounting-angle correction, Euler degrees: the hub sits rotated
// on the back of the hand, so the hand bone is offset from the raw hub
// orientation. Authored for the RIGHT hand in the solver's frame — these are
// the canonical left-hand values, which mirror (y/z sign-flip) twice: once for
// the hand side and once for the handedness of the frame.
export const HUB_CALIBRATION_OFFSET: Vec3 = [0, 5, -15];

/** Sensor orientation with its per-sensor calibration offset applied. */
function calibratedRotation(sensor: SensorState): Quat {
  return qMul(sensor.rotation, eulerVec(sensor.calibrationOffset));
}

/** Aim a finger's parent bone at a target, used to orient the finger chain. */
function fingerAim(targetDirection: Vec3, axis: Vec3): Quat {
  return qMul(lookRotation(targetDirection, axis), eulerVec([0, -90, 90]));
}

/**
 * Pose `skel` in place from one frame of glove sensor state. No-op when the
 * hand (hub) sensor is absent.
 *
 * The four numbered phases below run in the order the reference solver runs
 * them, and each reads the tree the previous one left behind. The numbering is a
 * reading aid, not a hint that they are independent steps to reorder.
 */
export function solveFingers(glove: GloveState, skel: HandSkeleton, hinges = true): void {
  // ── 1. Rest pose, then the hand root pinned to the hub ─────────────────────
  // Reset the root too, not only the fingers — see resetLocalTransforms. Without
  // it a single non-finite frame poisons the root permanently, which is the
  // difference between "one bad frame" and "this hand is gone until reload".
  skel.resetLocalTransforms();
  poseFingersInHand(skel, glove.handWidth, false);
  skel.propagate();

  const hubSensor = glove.sensors[HUB_SENSOR_ID];
  if (!hubSensor) return;
  const handBone = skel.sidedBone(Bone.LEFT_HAND);
  const armBone = skel.sidedBone(Bone.LEFT_LOWER_ARM);

  // This skeleton is rooted at the forearm, so the forearm moves freely with no
  // upper body to detach from.

  // The hub's mounting offset, x-mirrored for a right hand (see
  // FINGER_BONE_OFFSET — the table is authored for the left).
  const sign = glove.isRight ? 1 : -1;
  const [hubX, hubY, hubZ] = FINGER_BONE_OFFSET[HUB_SENSOR_ID];
  const hubOffset: Vec3 = [hubX * sign, hubY, hubZ];

  // Rotate the hand bone by the hub mounting-angle correction while keeping
  // the hub sensor itself at the origin, where the finger sensor positions
  // (hub-relative) expect it.
  const hubCalibration = eulerVec(hubSensor.calibrationOffset);
  handBone.alignRootTo(vNeg(vTransform(hubOffset, hubCalibration)), hubCalibration);

  // ── 2. Each finger, aimed from its own sensor ──────────────────────────────
  for (let i = 0; i < NUMBER_OF_FINGERS; i++) {
    const sensor = glove.sensors[i];
    if (!sensor) continue;
    // The thumb is the exception twice below: it has no medial joint, so its
    // sensor drives the proximal, and it is the one finger allowed to bend the
    // way the hinge floor exists to prevent.
    const isThumb = i === THUMB_FINGER_ID;
    const drivenBone = skel.sidedBone(DRIVEN_BONES[i]);
    const parentBone = drivenBone.parent!;
    const distalBone = drivenBone.children[0];

    const boneRotation = calibratedRotation(sensor);
    const boneXAxis = vTransform(VEC3_UNIT_X, boneRotation);

    const sensorWorldPosition = sensor.position;
    const targetPosition = vAdd(
      sensorWorldPosition,
      vTransform(vScale(vNeg(FINGER_BONE_OFFSET[i]), 1 / drivenBone.lossyScale), boneRotation),
    );

    let parentRotation = fingerAim(vSub(targetPosition, parentBone.position), boneXAxis);
    let localRotation = qMul(qInverse(parentRotation), boneRotation);

    // Hinge floor for all fingers but the thumb: when the joint would bend
    // backwards past -10°, push the parent aim back so it doesn't.
    if (!isThumb) {
      const rotatedY = vTransform(VEC3_UNIT_Y, localRotation);
      const localAxis = vNormalizeSafe([0, rotatedY[1], rotatedY[2]]);
      if (localAxis) {
        // Clamped, unlike the reference solver: the argument is a normalized
        // component so it is in range mathematically, but rounding can push it
        // a hair past ±1, where acos is NaN and the hand vanishes for a frame.
        // Deviation-free for every in-range input.
        const y = Math.min(Math.max(localAxis[1], -1), 1);
        const localAngle = Math.acos(y) * Math.sign(localAxis[2]) * -RAD2DEG;
        if (localAngle < 10) {
          const t = inverseLerp(-10, 10, localAngle);
          parentRotation = qMul(angleAxis(-localAngle + 10 * t, boneXAxis), parentRotation);
          localRotation = qMul(qInverse(parentRotation), boneRotation);
        }
      }
    }

    const axisAlignedLocalRotation = qProject(localRotation, VEC3_UNIT_X);
    const worldAxisCorrection = fromToRotation(
      vTransform(VEC3_UNIT_Y, qMul(parentRotation, axisAlignedLocalRotation)),
      vTransform(VEC3_UNIT_Y, qMul(parentRotation, localRotation)),
    );

    if (!isThumb && hinges) {
      parentRotation = qMul(qLerp(QUAT_IDENTITY, worldAxisCorrection, 0.25), parentRotation);
      localRotation = axisAlignedLocalRotation;
    }

    parentBone.rotation = parentRotation;
    drivenBone.localRotation = localRotation;
    distalBone.localRotation = qLerp(QUAT_IDENTITY, axisAlignedLocalRotation, 2 / 3);

    parentBone.updateChildTransformsRecursive();
  }

  // ── 3. The forearm, from the arm sensor ────────────────────────────────────
  // Fingers are posed in hub space; the arm sensor is also hub-relative while
  // the hub itself is world (IMU) space.
  const armSensor = glove.sensors[ARM_SENSOR_ID];
  if (!armSensor) return;
  let armSensorPosition = vTransform(armSensor.position, hubSensor.rotation);
  const armSensorOrientation = qMul(hubSensor.rotation, armSensor.rotation);

  // The arm follows the raw hub frame; only the hand gets the mounting
  // correction, which is what puts the ~16° bias at the wrist.
  armBone.rotation = armSensorOrientation;
  handBone.rotation = qMul(hubSensor.rotation, hubCalibration);
  armBone.updateChildTransformsRecursive();

  handBone.alignRootTo(VEC3_ZERO, qMul(hubSensor.rotation, hubCalibration));
  handBone.parent!.updateChildTransformsRecursive();

  const hubWorldPos = vAdd(handBone.position, handBone.transformVector(hubOffset));
  armSensorPosition = vAdd(armSensorPosition, hubWorldPos);

  // ── 4. World anchoring, when a Coil Pro is tracking ────────────────────────
  const coilSensor = glove.sensors[ARM_IN_WORLD_SENSOR_ID];
  if (!coilSensor?.isCoilPresent) return;

  // World-anchoring alignment, as separate rotation/translation deltas.
  const rotDelta = qNormalize(qMul(coilSensor.rotation, qInverse(armSensorOrientation)));
  const posDelta = vSub(coilSensor.position, vTransform(armSensorPosition, rotDelta));
  armBone.applyAlignment(rotDelta, posDelta);
  // Re-propagate from the arm's parent, falling back to the arm itself since it
  // is the skeleton root.
  (armBone.parent ?? armBone).updateChildTransformsRecursive();
}

/** Convenience: SensorState from raw per-frame sample fields. */
export function sensorState(
  rotation: Quat,
  position: Vec3 = VEC3_ZERO,
  calibrationOffset: Vec3 = VEC3_ZERO,
  isCoilPresent = false,
): SensorState {
  return { rotation, position, calibrationOffset, isCoilPresent };
}

/**
 * Preallocated backing for gloveStateInto: a GloveState whose sensors own
 * fixed rotation/position/calibration arrays, aliased here as mutable tuples
 * so the per-frame fill can write components without casts. One per rig; the
 * per-frame conversion then allocates nothing.
 */
export interface GloveStateScratch {
  state: GloveState;
  rot: [number, number, number, number][];
  pos: [number, number, number][];
  cal: [number, number, number][];
}

export function createGloveStateScratch(): GloveStateScratch {
  const rot: GloveStateScratch["rot"] = [];
  const pos: GloveStateScratch["pos"] = [];
  const cal: GloveStateScratch["cal"] = [];
  const sensors: SensorState[] = [];
  for (let id = 0; id < SENSOR_COUNT; id++) {
    const r: [number, number, number, number] = [0, 0, 0, 1];
    const p: [number, number, number] = [0, 0, 0];
    const c: [number, number, number] = [0, 0, 0];
    rot.push(r);
    pos.push(p);
    cal.push(c);
    sensors.push({ rotation: r, position: p, calibrationOffset: c, isCoilPresent: false });
  }
  return { state: { isRight: false, handWidth: 0, sensors }, rot, pos, cal };
}

/**
 * GloveState from a decoded frame sample, filled into caller-owned scratch
 * (see GloveStateScratch). Every sensor exists with identity defaults and
 * streamed data overrides it, so a sensor missing from one frame degrades
 * gracefully instead of dropping the solve.
 */
export function gloveStateInto(
  sample: GloveSample,
  isRight: boolean,
  scratch: GloveStateScratch,
  handWidth = 0,
): GloveState {
  const { state, rot, pos, cal } = scratch;
  state.isRight = isRight;
  state.handWidth = handWidth;
  const sign = isRight ? 1 : -1;
  for (let id = 0; id < SENSOR_COUNT; id++) {
    const q = sample.quats[id] ?? QUAT_IDENTITY;
    const r = rot[id];
    r[0] = q[0];
    r[1] = q[1];
    r[2] = q[2];
    r[3] = q[3];
    const sp = sample.positions[id] ?? VEC3_ZERO;
    const p = pos[id];
    p[0] = sp[0];
    p[1] = sp[1];
    p[2] = sp[2];
    const c = cal[id];
    if (id === HUB_SENSOR_ID) {
      c[0] = HUB_CALIBRATION_OFFSET[0];
      c[1] = HUB_CALIBRATION_OFFSET[1] * sign;
      c[2] = HUB_CALIBRATION_OFFSET[2] * sign;
    } else {
      c[0] = 0;
      c[1] = 0;
      c[2] = 0;
    }
    state.sensors[id]!.isCoilPresent = isCoilPresent(sample, id);
  }
  return state;
}
