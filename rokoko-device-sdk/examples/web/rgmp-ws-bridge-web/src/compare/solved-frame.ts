// One decoded frame of the sidecar's solved joint poses: the flat, reusable
// slot the rings buffer (see pose-ring.ts) and the comparison reads (see
// pose-delta.ts). Recognizing which streams carry the joints is solved-hand.ts.

import type { Quat, Vec3 } from "../solver/math.ts";
import type { DecodedStream } from "../protocol/rgmp-layout.ts";

/** The slice of a descriptor that frame reading needs (see solved-hand.ts). */
export interface JointStreams {
  streamIndex: number[];
}

/**
 * One frame of solved joint poses, in the glove's own sensor frame — the
 * sidecar does no rebasing — so these are directly comparable to this app's
 * solved skeleton with no conversion.
 *
 * Flat arrays, filled in place: one of these per ring slot, reused forever.
 */
export interface SolvedFrame {
  /** 3 per joint, in descriptor order. */
  positions: Float64Array;
  /** 4 per joint (x,y,z,w), in descriptor order. */
  rotations: Float64Array;
}

export function createSolvedFrame(jointCount: number): SolvedFrame {
  return {
    positions: new Float64Array(jointCount * 3),
    rotations: new Float64Array(jointCount * 4),
  };
}

/**
 * Whether `streams` carries a full transform for every joint the descriptor
 * expects.
 *
 * Checked before a ring slot is claimed rather than while filling one: the slots
 * are reused, so claiming for a frame that then turns out to be unreadable would
 * leave the previous occupant's pose published under the new timestamp — a hand
 * that never existed, at a time it didn't exist.
 */
export function canReadSolvedFrame(
  descriptor: JointStreams,
  streams: readonly DecodedStream[],
): boolean {
  for (const index of descriptor.streamIndex) {
    const stream = streams[index];
    if (stream === undefined || stream.values.length < 7) return false;
  }
  return true;
}

/**
 * Copy one decoded world group into `into` — position then orientation per
 * joint, as `FLOAT[7]` TRANSFORM streams carry them.
 *
 * Assumes `canReadSolvedFrame` passed; a short stream here would read
 * `undefined` as NaN.
 */
export function readSolvedFrame(
  descriptor: JointStreams,
  streams: readonly DecodedStream[],
  into: SolvedFrame,
): void {
  const { streamIndex } = descriptor;
  for (let i = 0; i < streamIndex.length; i++) {
    const v = streams[streamIndex[i]].values;
    const p = i * 3;
    into.positions[p] = Number(v[0]);
    into.positions[p + 1] = Number(v[1]);
    into.positions[p + 2] = Number(v[2]);
    const r = i * 4;
    into.rotations[r] = Number(v[3]);
    into.rotations[r + 1] = Number(v[4]);
    into.rotations[r + 2] = Number(v[5]);
    into.rotations[r + 3] = Number(v[6]);
  }
}

export function solvedPosition(frame: SolvedFrame, index: number): Vec3 {
  const o = index * 3;
  return [frame.positions[o], frame.positions[o + 1], frame.positions[o + 2]];
}

export function solvedRotation(frame: SolvedFrame, index: number): Quat {
  const o = index * 4;
  return [
    frame.rotations[o],
    frame.rotations[o + 1],
    frame.rotations[o + 2],
    frame.rotations[o + 3],
  ];
}
