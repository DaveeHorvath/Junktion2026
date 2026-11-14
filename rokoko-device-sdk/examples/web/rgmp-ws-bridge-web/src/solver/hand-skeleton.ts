// The hand skeleton and its default (rest) pose.
//
// The skeleton is the forearm sub-branch of the body model: forearm → hand →
// five fingers (thumb: metacarpal/proximal/distal; the others add a medial
// joint), with T-pose local transforms loaded from hand-skeleton-data.ts. Each
// joint carries a numeric bone id; the ids are laid out so that for any
// left-side bone, `id + 1` is the matching right-side bone, which sidedBone()
// exploits to resolve a left-named bone to whichever side this skeleton is.

import { HAND_JOINTS, type HandJointData } from "./hand-skeleton-data.ts";
import { TransformNode } from "./transform-node.ts";
import {
  QUAT_IDENTITY,
  angleAxis,
  eulerVec,
  lookRotation,
  qMul,
  quatToEuler,
  vCross,
  vTransform,
  type Quat,
  type Vec3,
} from "./math.ts";

/** Bone ids for the hand skeleton (left-side names; right is `id + 1`). */
export const Bone = {
  NONE: -1,
  LEFT_LOWER_ARM: 19,
  RIGHT_LOWER_ARM: 20,
  LEFT_HAND: 21,
  RIGHT_HAND: 22,
  LEFT_THUMB_METACARPAL: 23,
  LEFT_THUMB_PROXIMAL: 25,
  LEFT_THUMB_DISTAL: 27,
  LEFT_INDEX_METACARPAL: 29,
  LEFT_INDEX_PROXIMAL: 31,
  LEFT_INDEX_MEDIAL: 33,
  LEFT_INDEX_DISTAL: 35,
  LEFT_MIDDLE_METACARPAL: 37,
  LEFT_MIDDLE_PROXIMAL: 39,
  LEFT_MIDDLE_MEDIAL: 41,
  LEFT_MIDDLE_DISTAL: 43,
  LEFT_RING_METACARPAL: 45,
  LEFT_RING_PROXIMAL: 47,
  LEFT_RING_MEDIAL: 49,
  LEFT_RING_DISTAL: 51,
  LEFT_LITTLE_METACARPAL: 53,
  LEFT_LITTLE_PROXIMAL: 55,
  LEFT_LITTLE_MEDIAL: 57,
  LEFT_LITTLE_DISTAL: 59,
} as const;

export type HandSide = "left" | "right";

export class HandSkeleton {
  readonly side: HandSide;
  readonly isRight: boolean;
  /** All nodes in glTF order (parents before children). */
  readonly nodes: readonly TransformNode[];
  /** Source joint data (names, parent indices, bone ids), same order. */
  readonly joints: readonly HandJointData[];
  private readonly boneMap: Map<number, TransformNode>;

  constructor(side: HandSide) {
    this.side = side;
    this.isRight = side === "right";
    this.joints = HAND_JOINTS[side];

    const nodes = this.joints.map((j) => new TransformNode(j.name));
    this.joints.forEach((j, i) => {
      if (j.parent >= 0) {
        nodes[i].parent = nodes[j.parent];
        nodes[j.parent].children.push(nodes[i]);
      }
      nodes[i].localPosition = j.localPos;
      nodes[i].localRotation = j.localRot;
    });
    TransformNode.propagateWorldTransforms(nodes);
    this.nodes = nodes;

    this.boneMap = new Map();
    this.joints.forEach((j, i) => {
      if (j.bone >= 0) this.boneMap.set(j.bone, nodes[i]);
    });
  }

  /** The transform node mapped to a bone id. */
  bone(boneId: number): TransformNode {
    const node = this.boneMap.get(boneId);
    if (!node) throw new Error(`Bone ${boneId} not present in ${this.side} hand skeleton`);
    return node;
  }

  /**
   * Resolve a LEFT_* bone id to this skeleton's side: left ids pass through,
   * right ids are the left id + 1. Lets the solver name bones once (left) and
   * run unchanged on either hand.
   */
  sidedBone(leftBoneId: number): TransformNode {
    return this.bone(leftBoneId + (this.isRight ? 1 : 0));
  }

  /** Re-run FK for the whole skeleton after local-rotation edits. */
  propagate(): void {
    TransformNode.propagateWorldTransforms(this.nodes);
  }

  /**
   * Restore every joint's local transform from the T-pose table, without
   * propagating.
   *
   * poseFingersInHand resets the hand and the finger joints but not the
   * *forearm root*, and the root is what solveFingers' alignments move. Without
   * this, one frame that drives the root non-finite (a garbage sensor frame
   * will) latches: every later alignment composes with the root's current
   * transform, so no amount of good input recovers and the hand stays gone.
   *
   * For finite input it is a no-op — the alignments cancel the incoming root
   * transform exactly — so it costs nothing and changes no pose.
   */
  resetLocalTransforms(): void {
    this.joints.forEach((j, i) => {
      this.nodes[i].localPosition = j.localPos;
      this.nodes[i].localRotation = j.localRot;
    });
  }

  /**
   * Parent-relative euler angles (degrees, ZXY — see quatToEuler) of one bone,
   * in the solver's sensor frame. For finger joints the hinge (flexion) is the
   * x component. Reflects the last solve (solveFingers), or the rest pose.
   */
  localJointAngles(leftBoneId: number): Vec3 {
    return quatToEuler(this.sidedBone(leftBoneId).localRotation);
  }

  /** localJointAngles for every joint, keyed by node name. */
  jointAngles(): Record<string, Vec3> {
    const angles: Record<string, Vec3> = {};
    for (const node of this.nodes) angles[node.name] = quatToEuler(node.localRotation);
    return angles;
  }
}

// ── Default pose ─────────────────────────────────────────────────────────────

/**
 * Pose a finger bone from an (azimuth-x, azimuth-y, roll) triple in degrees:
 * azimuth-x/y swing the bone away from its rest direction, roll twists it
 * about its own length.
 */
export function azimuthVectorToRotation(vector: Vec3): Quat {
  const FORWARD: Vec3 = [0, -1, 0];
  const SPACE = lookRotation([0, -1, 0], [-1, 0, 0]);
  const axis = vCross(FORWARD, vTransform([vector[0], vector[1], 0], SPACE));
  const deg = Math.hypot(vector[0], vector[1]);
  const roll: Vec3 = [0, -vector[2], 0];
  return qMul(angleAxis(deg, axis), eulerVec(roll));
}

// Apply a rest-pose azimuth to a bone, mirrored for the left hand. The angles
// below are authored for the right hand; a left hand is its mirror image, so
// azimuth-y and roll flip sign. This is anatomy, not a coordinate convention —
// it is needed whatever frame the solver runs in.
function setSidedRotation(skel: HandSkeleton, leftBoneId: number, azimuth: Vec3): void {
  const v: Vec3 = skel.isRight ? azimuth : [azimuth[0], -azimuth[1], -azimuth[2]];
  skel.sidedBone(leftBoneId).localRotation = azimuthVectorToRotation(v);
}

/**
 * Reset the hand to the neutral pose the solver starts from each frame:
 * metacarpals fanned outward, every other finger joint at identity. `width`
 * (meters, knuckle span) widens the fan; 0 keeps the model default.
 */
export function poseFingersInHand(skel: HandSkeleton, width = 0, onlyMetacarpals = false): void {
  // Model constant: distance between knuckle joints in the Newton mesh.
  const NEWTON_HAND_WIDTH = 0.0565;

  let fingerAngleSpacing = 10;
  if (width > 0) {
    const size = skel.sidedBone(Bone.LEFT_HAND).lossyScale;
    fingerAngleSpacing = (width / NEWTON_HAND_WIDTH) * size * fingerAngleSpacing;
  }

  skel.sidedBone(Bone.LEFT_HAND).localRotation = QUAT_IDENTITY;
  setSidedRotation(skel, Bone.LEFT_THUMB_METACARPAL, [30, 30, -90]);
  setSidedRotation(skel, Bone.LEFT_INDEX_METACARPAL, [0, fingerAngleSpacing, -1.25]);
  setSidedRotation(skel, Bone.LEFT_MIDDLE_METACARPAL, [0, 0, 0]);
  setSidedRotation(skel, Bone.LEFT_RING_METACARPAL, [3, -fingerAngleSpacing, 2.5]);
  setSidedRotation(skel, Bone.LEFT_LITTLE_METACARPAL, [7, -fingerAngleSpacing * 2, 5]);

  if (onlyMetacarpals) return;

  const zero = [
    Bone.LEFT_THUMB_PROXIMAL,
    Bone.LEFT_INDEX_PROXIMAL,
    Bone.LEFT_MIDDLE_PROXIMAL,
    Bone.LEFT_RING_PROXIMAL,
    Bone.LEFT_LITTLE_PROXIMAL,
    Bone.LEFT_INDEX_MEDIAL,
    Bone.LEFT_MIDDLE_MEDIAL,
    Bone.LEFT_RING_MEDIAL,
    Bone.LEFT_LITTLE_MEDIAL,
    Bone.LEFT_THUMB_DISTAL,
    Bone.LEFT_INDEX_DISTAL,
    Bone.LEFT_MIDDLE_DISTAL,
    Bone.LEFT_RING_DISTAL,
    Bone.LEFT_LITTLE_DISTAL,
  ];
  for (const b of zero) skel.sidedBone(b).localRotation = QUAT_IDENTITY;
}
