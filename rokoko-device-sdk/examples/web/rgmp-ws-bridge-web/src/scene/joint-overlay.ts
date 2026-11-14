// The pieces shared by every "joints published by the sidecar, drawn over the
// solved hand" overlay — currently OpenXR (openxr-overlay.ts).
//
// They all draw the same shape: a parent-indexed joint set whose world
// positions arrive per frame, rendered as bone lines plus a per-joint marker.
// Only the frame convention, the color and what the triads mean differ, and
// those live in the per-format modules. Keeping the buffer plumbing here means
// a fix to it lands in every overlay, rather than in whichever one someone
// remembered.

import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  type MeshStandardMaterial,
} from "three";
import type { SolvedFrame } from "../compare/solved-frame.ts";

/** Hand-mesh opacity while an overlay is up — see `fadeMeshForOverlay`. */
export const OVERLAY_MESH_FADE_OPACITY = 0.45;

/**
 * Fade (or restore) a rig's hand-mesh material so an overlay's joints stay
 * visible inside the fingers.
 *
 * Lowering opacity alone would not do it: the depth-tested joint markers are
 * culled by the mesh's depth, however translucent its color. So the fade also
 * stops the mesh writing depth — that is what actually lets the joints show
 * through, at the price of the mesh's own faces blending front-through-back,
 * which reads fine at this opacity. Takes the rig's own material (a per-rig
 * clone, see buildHandMesh); fading a shared one would bleed into other hands.
 *
 * `faded` is the OR of every overlay currently on screen: one mesh, one fade,
 * and it must stay down while any of them is still drawing.
 *
 * Cheap enough to call every frame: it writes only on a state change.
 */
export function fadeMeshForOverlay(material: MeshStandardMaterial, faded: boolean): void {
  if (material.transparent === faded) return;
  material.transparent = faded;
  material.depthWrite = !faded;
  material.opacity = faded ? OVERLAY_MESH_FADE_OPACITY : 1;
  // `transparent` is baked into the compiled program (an opaque one forces
  // alpha to 1.0 in the shader), so flipping it needs a recompile or the
  // opacity above is ignored: the mesh then paints alpha-1 in the transparent
  // pass with depth writes off — over the overlays, and its own back faces
  // over its front. Both program variants are cached after first use.
  material.needsUpdate = true;
}

/** An overlay's bone geometry and the bookkeeping needed to drive it. */
export interface JointBones {
  geometry: BufferGeometry;
  /** Two endpoints per bone, rewritten every frame. */
  positions: BufferAttribute;
  /** Parent joint index per joint, -1 for a root (which draws no bone). */
  parents: readonly number[];
}

/** Build the bone-line geometry for one hand's joint set. */
export function buildJointBones(parents: readonly number[]): JointBones {
  const bones = parents.filter((p) => p >= 0).length;
  const positions = new BufferAttribute(new Float32Array(bones * 6), 3);
  positions.setUsage(DynamicDrawUsage);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", positions);
  return { geometry, positions, parents };
}

/** Point the bones at one frame's joint positions. */
export function updateJointBones(bones: JointBones, frame: SolvedFrame): void {
  const array = bones.positions.array as Float32Array;
  const { positions } = frame;
  let s = 0;
  for (let i = 0; i < bones.parents.length; i++) {
    const parent = bones.parents[i];
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
  bones.positions.needsUpdate = true;
}
