// Measuring how far apart the two solvers put a hand, joint by joint. Pure
// and framework-free; the frames come matched by timestamp from pose-ring.ts
// and `scene/ghost-overlay.ts` folds the result into the on-screen readout.

import { RAD2DEG, qInverse, qMul, type Quat, type Vec3 } from "../solver/math.ts";
import { solvedRotation, type SolvedFrame } from "./solved-frame.ts";

/** Anything exposing a joint's world pose — `TransformNode` satisfies it. */
export interface JointPose {
  readonly position: Vec3;
  readonly rotation: Quat;
}

/**
 * Map solved joint order onto another skeleton's joint order by Newton name:
 * `mapping[solvedIndex]` is the index into `webNames`, or -1 when that joint
 * has no counterpart.
 *
 * Both sides are generated from the same joint table, so this is normally the
 * identity — building it by name anyway means a table that drifts on one side
 * shows up as unmatched joints rather than as a silently scrambled overlay.
 */
export function mapJoints(solvedNames: readonly string[], webNames: readonly string[]): number[] {
  const index = new Map(webNames.map((name, i) => [name, i]));
  return solvedNames.map((name) => index.get(name) ?? -1);
}

/** How far apart the two solvers put this hand. */
export interface PoseDelta {
  /** Largest per-joint world-position difference, in meters. */
  maxPositionM: number;
  /** The joint at `maxPositionM`; empty when nothing was compared. */
  maxPositionJoint: string;
  /** Largest per-joint world-rotation difference, in degrees. */
  maxAngleDeg: number;
  /** The joint at `maxAngleDeg`; empty when nothing was compared. */
  maxAngleJoint: string;
  /** Joints present on both sides, and so actually compared. */
  compared: number;
  /** Joints the name mapping could not pair up. */
  unmatched: number;
}

/**
 * The angle between two orientations, in degrees.
 *
 * Measured off the relative rotation as `2·atan2(|xyz|, |w|)` rather than the
 * usual `2·acos(|a·b|)`. The dot-product form is catastrophically
 * ill-conditioned exactly where this is used — near agreement. At a dot of
 * 1−ε, `acos` amplifies by 1/√(2ε), so f32's ε≈1e-7 puts a floor of ~0.026° on
 * every reading: two solvers agreeing perfectly would still be reported as
 * 0.026° apart, purely from the wire encoding. The atan2 form stays accurate
 * down to zero, which is the whole point of showing the number.
 *
 * `abs` on `w` takes the shorter of the two arcs, so q and -q — the same
 * orientation — come out as 0 rather than 360.
 */
export function quatAngleDeg(a: Quat, b: Quat): number {
  const r = qMul(qInverse(a), b);
  return 2 * Math.atan2(Math.hypot(r[0], r[1], r[2]), Math.abs(r[3])) * RAD2DEG;
}

/**
 * Compare a solved frame against this app's posed skeleton, joint by joint.
 *
 * Reports the worst joint rather than an average: an average over 26 joints
 * hides a single badly-solved fingertip, which is exactly the failure this is
 * looking for.
 */
export function comparePose(
  solved: SolvedFrame,
  jointNames: readonly string[],
  mapping: readonly number[],
  web: readonly JointPose[],
): PoseDelta {
  const delta: PoseDelta = {
    maxPositionM: 0,
    maxPositionJoint: "",
    maxAngleDeg: 0,
    maxAngleJoint: "",
    compared: 0,
    unmatched: 0,
  };

  for (let i = 0; i < mapping.length; i++) {
    const w = mapping[i];
    if (w < 0 || w >= web.length) {
      delta.unmatched++;
      continue;
    }
    delta.compared++;

    const node = web[w];
    const o = i * 3;
    const dx = solved.positions[o] - node.position[0];
    const dy = solved.positions[o + 1] - node.position[1];
    const dz = solved.positions[o + 2] - node.position[2];
    const distance = Math.hypot(dx, dy, dz);
    if (distance > delta.maxPositionM) {
      delta.maxPositionM = distance;
      delta.maxPositionJoint = jointNames[i] ?? "";
    }

    const angle = quatAngleDeg(solvedRotation(solved, i), node.rotation);
    if (angle > delta.maxAngleDeg) {
      delta.maxAngleDeg = angle;
      delta.maxAngleJoint = jointNames[i] ?? "";
    }
  }

  return delta;
}
