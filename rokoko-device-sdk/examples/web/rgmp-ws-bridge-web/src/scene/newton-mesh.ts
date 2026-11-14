// Newton hand mesh: cut the skinned hand branch out of newton.glb and drive
// its bones from a solved HandSkeleton.
//
// The glb is in centimeters with the full body skeleton. Per rig we clone it,
// keep only triangles whose vertices are weighted to the hand branch (forearm
// and below), and detach the forearm bone subtree (the caller renders it under
// a GLB_SCALE-scaled group). Each frame the solved local transforms are written
// back into those bones, positions scaled into glb units. three.js skinning in
// the default "attached" bind mode follows bone world matrices wherever the
// mesh object sits, so the bones alone place the hand.
//
// Framework-free three.js (no React): buildHandMesh/driveMeshBones are pure,
// and unit-tested. Those tests are not part of the SDK.
// HandRig.tsx only wires the two functions up.

import {
  BufferGeometry,
  MeshStandardMaterial,
  SkinnedMesh,
  type Bone as ThreeBone,
  type Object3D,
} from "three";
import { SkeletonUtils } from "three/addons/Addons.js";
import { useGLTF } from "@react-three/drei";
import { HAND_JOINTS } from "../solver/hand-skeleton-data.ts";
import type { HandSide, HandSkeleton } from "../solver/hand-skeleton.ts";

export const NEWTON_GLB_URL = "/newton.glb";
useGLTF.preload(NEWTON_GLB_URL);

/** glb units are centimeters; the solver works in meters. */
export const GLB_SCALE = 0.01;

const MESH_MATERIAL = new MeshStandardMaterial({
  color: "#7a8194",
  roughness: 0.8,
  metalness: 0.05,
});

/** The hand mesh cut from a cloned glb scene, plus the bones that drive it. */
export interface HandMesh {
  /** Skinned meshes trimmed to the hand branch. */
  meshes: SkinnedMesh[];
  /**
   * The one material all of this rig's meshes share — a per-rig clone, so a
   * caller fading its hand (the OpenXR overlay does) cannot bleed the change
   * into the other hand.
   */
  material: MeshStandardMaterial;
  /** Forearm root, detached from the body; render under a GLB_SCALE group. */
  forearmBone: ThreeBone | null;
  /** Branch bones in HandSkeleton node order; null where the glb lacks a joint. */
  branchBones: (ThreeBone | null)[];
}

/**
 * Clone `scene`, cut it to the `side` hand branch, and detach the forearm.
 * Returns the trimmed meshes and the branch bones in skeleton-node order.
 */
export function buildHandMesh(scene: Object3D, side: HandSide): HandMesh {
  const cloned = SkeletonUtils.clone(scene);
  const byName = new Map<string, Object3D>();
  cloned.traverse((o) => byName.set(o.name, o));

  const branchBones = HAND_JOINTS[side].map((j) => (byName.get(j.name) as ThreeBone) ?? null);
  // The solver's transforms absorb the model's per-bone scale into positions,
  // so neutralize scale on the bones we drive.
  branchBones.forEach((b) => b?.scale.set(1, 1, 1));
  const forearmBone = branchBones[0];
  forearmBone?.removeFromParent();

  const branchNames = new Set(HAND_JOINTS[side].map((j) => j.name));
  const material = MESH_MATERIAL.clone();
  const meshes: SkinnedMesh[] = [];
  cloned.traverse((o) => {
    if (!(o instanceof SkinnedMesh)) return;
    const jointIdx = new Set<number>();
    o.skeleton.bones.forEach((b, i) => {
      if (branchNames.has(b.name)) jointIdx.add(i);
    });
    if (jointIdx.size === 0) return;
    const filtered = filterGeometryToJoints(o.geometry, jointIdx);
    if (!filtered) return;
    o.geometry = filtered;
    o.material = material;
    o.frustumCulled = false; // bones move far from the bind-pose bounds
    meshes.push(o);
  });

  return { meshes, material, forearmBone, branchBones };
}

/**
 * Write the skeleton's solved local transforms into the cut mesh's bones,
 * scaling positions back into glb (centimeter) units. The forearm root's local
 * equals its world transform (no parent).
 */
export function driveMeshBones(branchBones: (ThreeBone | null)[], skel: HandSkeleton): void {
  skel.nodes.forEach((node, i) => {
    const bone = branchBones[i];
    if (!bone) return;
    const p = node.localPosition;
    const q = node.localRotation;
    bone.position.set(p[0] / GLB_SCALE, p[1] / GLB_SCALE, p[2] / GLB_SCALE);
    bone.quaternion.set(q[0], q[1], q[2], q[3]);
  });
}

/**
 * Subset an indexed skinned geometry to triangles whose vertices are all
 * weighted (>= 0.5 total) to the given skeleton joint indices. Attribute
 * buffers are shared with the source; only the index is new. Returns null
 * when nothing survives (e.g. the head mesh for a hand branch).
 */
export function filterGeometryToJoints(
  src: BufferGeometry,
  joints: Set<number>,
): BufferGeometry | null {
  const index = src.getIndex();
  const skinIndex = src.getAttribute("skinIndex");
  const skinWeight = src.getAttribute("skinWeight");
  if (!index || !skinIndex || !skinWeight) return null;

  const vertexCount = src.getAttribute("position").count;
  const inBranch = new Uint8Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    let w = 0;
    for (let k = 0; k < 4; k++) {
      if (joints.has(skinIndex.getComponent(v, k))) w += skinWeight.getComponent(v, k);
    }
    inBranch[v] = w >= 0.5 ? 1 : 0;
  }

  const kept: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t);
    const b = index.getX(t + 1);
    const c = index.getX(t + 2);
    if (inBranch[a] && inBranch[b] && inBranch[c]) kept.push(a, b, c);
  }
  if (kept.length === 0) return null;

  const geo = new BufferGeometry();
  for (const name of Object.keys(src.attributes)) {
    geo.setAttribute(name, src.getAttribute(name));
  }
  geo.setIndex(kept);
  return geo;
}
