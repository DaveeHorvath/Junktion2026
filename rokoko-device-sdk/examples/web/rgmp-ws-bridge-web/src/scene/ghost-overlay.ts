// The sidecar's solved skeleton, drawn over this app's own — the visual half of
// the solver comparison (compare/pose-delta.ts is the measuring half).
//
// A second stick figure in a contrasting color, built from the solved hand's
// published joint hierarchy and driven straight from its world transforms. No
// forward kinematics and no skeleton of its own: `rkk-hand-solver --emit world`
// sends every joint's world pose, so drawing it is a copy.
//
// Nothing here converts frames. The sidecar emits in the glove's own sensor
// frame, which is the frame this app's solver works in, so the overlay goes
// inside HandRig's existing rebasing groups and the two skeletons land in the
// same space. That is what makes the overlay
// worth looking at: any visible offset is a real difference, not a convention
// mismatch.

import { BufferAttribute, BufferGeometry, DynamicDrawUsage } from "three";
import { comparePose, mapJoints, type JointPose, type PoseDelta } from "../compare/pose-delta.ts";
import type { SolvedFrame } from "../compare/solved-frame.ts";
import type { SolvedHandDescriptor } from "../compare/solved-hand.ts";

/** Line color for the sidecar's skeleton — amber against the app's blue. */
export const GHOST_COLOR = "#ffb454";

/**
 * Drawn dashed, and with the depth test off, for one reason: when the two
 * solvers agree the two skeletons are *exactly* coincident.
 *
 * Solid and depth-tested, that made the overlay unreadable. In the default mesh
 * display the skinned hand occludes it (as it does the app's own stick figure),
 * so it looked absent; where it did show, two coincident solid lines just
 * z-fight into a muddy color, which reads as "the skeleton changed color", not
 * as "here are two skeletons agreeing".
 *
 * Dashes let the blue line show through the gaps, so agreement looks like what
 * it is — and no depth test means the overlay is visible in every display mode,
 * which is what a diagnostic wants. Divergence then shows as amber separating
 * from blue.
 *
 * Sizes are in scene units (meters); finger bones are ~0.02-0.04 long, so these
 * give a few dashes per bone.
 */
export const GHOST_DASH = { size: 0.004, gap: 0.003 } as const;

/** Draw the overlay after the scene, so depthTest:false puts it on top. */
export const GHOST_RENDER_ORDER = 10;

/** The overlay's geometry and the bookkeeping needed to drive it. */
export interface GhostOverlay {
  geometry: BufferGeometry;
  /** Two endpoints per bone, rewritten every frame. */
  positions: BufferAttribute;
  /**
   * Per-vertex distance along its bone, which is what makes the dashes. Filled
   * on the first real frame and never again: only joint *rotations* change, so
   * bone lengths are fixed for the session.
   */
  lineDistances: BufferAttribute;
  /** Parent joint index per joint, -1 for the root (which draws no bone). */
  parents: readonly number[];
  jointNames: readonly string[];
  /** Solved joint index -> index into this app's skeleton nodes; -1 if unpaired. */
  mapping: readonly number[];
  /** Whether `lineDistances` has been filled from a real frame yet. */
  dashesReady: boolean;
}

/**
 * Build the overlay for one solved hand, paired against this app's joint order.
 *
 * `webJointNames` are the Newton names of this app's skeleton nodes, in node
 * order. Both sides come from the same generated joint table, so the pairing is
 * normally the identity — doing it by name anyway means a table that drifts on
 * one side shows up as unmatched joints in the readout instead of a silently
 * scrambled overlay.
 */
export function buildGhost(
  descriptor: SolvedHandDescriptor,
  webJointNames: readonly string[],
): GhostOverlay {
  const bones = descriptor.parents.filter((p) => p >= 0).length;
  const positions = new BufferAttribute(new Float32Array(bones * 6), 3);
  positions.setUsage(DynamicDrawUsage);
  // One distance per vertex, two vertices per bone.
  const lineDistances = new BufferAttribute(new Float32Array(bones * 2), 1);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", positions);
  geometry.setAttribute("lineDistance", lineDistances);

  return {
    geometry,
    positions,
    lineDistances,
    parents: descriptor.parents,
    jointNames: descriptor.jointNames,
    mapping: mapJoints(descriptor.jointNames, webJointNames),
    dashesReady: false,
  };
}

/** Point the overlay's bones at one solved frame's world joint positions. */
export function updateGhost(ghost: GhostOverlay, frame: SolvedFrame): void {
  const array = ghost.positions.array as Float32Array;
  const { positions } = frame;
  let s = 0;
  for (let i = 0; i < ghost.parents.length; i++) {
    const parent = ghost.parents[i];
    if (parent < 0) continue;
    const from = parent * 3;
    const to = i * 3;
    array[s] = positions[from];
    array[s + 1] = positions[from + 1];
    array[s + 2] = positions[from + 2];
    array[s + 3] = positions[to];
    array[s + 4] = positions[to + 1];
    array[s + 5] = positions[to + 2];
    s += 6;
  }
  ghost.positions.needsUpdate = true;

  if (!ghost.dashesReady) fillLineDistances(ghost);
}

/**
 * Measure each bone and write the per-vertex dash distances, once.
 *
 * Done by hand rather than through `LineSegments.computeLineDistances()`, which
 * allocates a fresh array and BufferAttribute on every call — and this only ever
 * needs doing once, since a solve changes joint rotations and never bone lengths.
 * Skipped until a frame with real geometry has landed, because the buffer starts
 * as zeros and a zero-length bone would give no dashes at all.
 */
function fillLineDistances(ghost: GhostOverlay): void {
  const positions = ghost.positions.array as Float32Array;
  const distances = ghost.lineDistances.array as Float32Array;
  let total = 0;
  for (let bone = 0; bone < distances.length / 2; bone++) {
    const o = bone * 6;
    const length = Math.hypot(
      positions[o + 3] - positions[o],
      positions[o + 4] - positions[o + 1],
      positions[o + 5] - positions[o + 2],
    );
    distances[bone * 2] = 0;
    distances[bone * 2 + 1] = length;
    total += length;
  }
  if (total === 0) return; // still the initial all-zero buffer
  ghost.lineDistances.needsUpdate = true;
  ghost.dashesReady = true;
}

/** Measure this app's posed skeleton against one solved frame. */
export function measureGhost(
  ghost: GhostOverlay,
  frame: SolvedFrame,
  webNodes: readonly JointPose[],
): PoseDelta {
  return comparePose(frame, ghost.jointNames, ghost.mapping, webNodes);
}

/**
 * How often the readout is rewritten, in milliseconds.
 *
 * The comparison runs per animation frame, but a line of text replaced 60 times
 * a second is unreadable — every field blurs. So each frame folds into a peak
 * (`foldDelta`) and the text is rewritten at this interval with the worst value
 * since the last one. Peak rather than latest for the same reason `comparePose`
 * reports the worst joint: a transient disagreement is exactly what must not be
 * missed between two reads.
 */
export const READOUT_INTERVAL_MS = 500;

/**
 * Below this, a position difference is f32 wire encoding rather than a solver
 * disagreement: positions are meters at ~0.1 scale, so f32's ~1e-7 relative
 * precision is ~1e-5 mm.
 */
const POSITION_FLOOR_MM = 0.001;

/** As POSITION_FLOOR_MM, for orientation. Measured agreement sits near 1e-5°. */
const ANGLE_FLOOR_DEG = 0.001;

/** The worst difference seen since the readout was last written. */
export interface DeltaPeak {
  maxPositionMm: number;
  maxPositionJoint: string;
  maxAngleDeg: number;
  maxAngleJoint: string;
  maxLagMs: number;
  /** Joints compared on the most recent frame. */
  compared: number;
  /** Joints left unpaired on the most recent frame. */
  unmatched: number;
  frames: number;
}

export function createDeltaPeak(): DeltaPeak {
  return {
    maxPositionMm: 0,
    maxPositionJoint: "",
    maxAngleDeg: 0,
    maxAngleJoint: "",
    maxLagMs: 0,
    compared: 0,
    unmatched: 0,
    frames: 0,
  };
}

export function resetDeltaPeak(peak: DeltaPeak): void {
  peak.maxPositionMm = 0;
  peak.maxPositionJoint = "";
  peak.maxAngleDeg = 0;
  peak.maxAngleJoint = "";
  peak.maxLagMs = 0;
  peak.compared = 0;
  peak.unmatched = 0;
  peak.frames = 0;
}

/** Fold one frame's comparison into the running peak. */
export function foldDelta(peak: DeltaPeak, delta: PoseDelta, lagMs: number): void {
  const mm = delta.maxPositionM * 1000;
  if (mm > peak.maxPositionMm) {
    peak.maxPositionMm = mm;
    peak.maxPositionJoint = delta.maxPositionJoint;
  }
  if (delta.maxAngleDeg > peak.maxAngleDeg) {
    peak.maxAngleDeg = delta.maxAngleDeg;
    peak.maxAngleJoint = delta.maxAngleJoint;
  }
  if (lagMs > peak.maxLagMs) peak.maxLagMs = lagMs;
  peak.compared = delta.compared;
  peak.unmatched = delta.unmatched;
  peak.frames++;
}

/**
 * One field of the readout. Below the encoding floor the *value* is meaningless
 * and so is the joint that carried it — whichever joint happened to round worst
 * this frame, flickering at random. Saying "below what f32 can resolve" is both
 * truthful and stable to read; naming a joint there would be noise dressed as a
 * finding.
 */
function formatField(label: string, value: number, joint: string, floor: number, unit: string) {
  if (value < floor) return `${label} <${floor}${unit}`;
  return `${label} ${value.toFixed(3)}${unit}${joint ? ` @${joint}` : ""}`;
}

/** The peak as one line of text, for the corner readout. */
export function formatPeak(side: string, peak: DeltaPeak): string {
  if (peak.frames === 0) return formatWaiting(side);
  if (peak.compared === 0) return `${side} · no joints paired with the solver's`;

  const parts = [
    side,
    formatField("Δpos", peak.maxPositionMm, peak.maxPositionJoint, POSITION_FLOOR_MM, " mm"),
    formatField("Δrot", peak.maxAngleDeg, peak.maxAngleJoint, ANGLE_FLOOR_DEG, "°"),
    `lag ${peak.maxLagMs.toFixed(1)} ms`,
  ];
  if (peak.unmatched > 0) parts.push(`${peak.unmatched} unpaired`);
  return parts.join(" · ");
}

/** Shown while the two streams have no frame in common yet. */
export function formatWaiting(side: string): string {
  return `${side} · waiting for a frame both solvers have`;
}
