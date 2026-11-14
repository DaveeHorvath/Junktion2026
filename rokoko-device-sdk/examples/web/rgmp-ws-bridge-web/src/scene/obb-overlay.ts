// Sensor-envelope OBBs (pure, renderer-free; HandRig mounts the meshes).
//
// A device advertises each sensor's physical envelope in the stream
// definition's static_data as a CUSTOM entry labelled "OBB": a FLOAT[10]
// value of center(3) + quaternion xyzw(4) + half-extents(3), meters, in the
// entry's target frame. This module detects and bakes those entries, maps
// them onto the glove's sensor ids, and builds the shared wireframe-cube
// geometry — mirroring the C++ visualizer's is_obb_entry/bbox_renderer.
//
// Parsing and baking are frame-agnostic on purpose: only resolveGloveObbs
// knows about gloves. A future definition-driven transform graph would
// replace that one function and keep the rest.

import { BufferAttribute, BufferGeometry } from "three";
import type { StaticDataEntry, StreamDefinition } from "../protocol/rgmp-layout.ts";
import { resolveSensorId } from "../solver/smartglove.ts";
import { qNormalize, type Quat, type Vec3 } from "../solver/math.ts";

/** Wireframe color — the C++ visualizer's default box color {0.9, 0.6, 0.2}. */
export const OBB_COLOR = "#e69933";

export const OBB_CUSTOM_LABEL = "OBB";

/** The wire shape an OBB value must have: a FLOAT vector of 10. */
const OBB_DATA_TYPE_RE = /^FLOAT\[\s*10\s*\]$/;

const OBB_FLOAT_COUNT = 10;

/** One baked OBB static: local pose + half-extents in its target frame. */
export interface ObbStatic {
  targetFrame: string;
  referenceFrame?: string;
  /** Box center in the target frame, meters. */
  center: Vec3;
  /** Box orientation in the target frame, normalized [x, y, z, w]. */
  quat: Quat;
  halfExtents: Vec3;
}

/**
 * True if this static entry is a CUSTOM/"OBB"/FLOAT[10] envelope. Never
 * throws: the definition JSON is cast unchecked upstream (rgmp-client.ts), so
 * every field is treated as untrusted. Matches the vector form only —
 * FLOAT[10,1] and friends are rejected, like the C++ is_vector() check — and
 * tolerates extra array elements beyond the first 10.
 */
export function isObbEntry(entry: StaticDataEntry): boolean {
  if (entry.measure_type !== "CUSTOM" || entry.custom_label !== OBB_CUSTOM_LABEL) return false;
  if (typeof entry.data_type !== "string" || !OBB_DATA_TYPE_RE.test(entry.data_type.trim())) {
    return false;
  }
  const { value } = entry;
  if (!Array.isArray(value) || value.length < OBB_FLOAT_COUNT) return false;
  for (let i = 0; i < OBB_FLOAT_COUNT; i++) {
    const v: unknown = value[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return true;
}

/** All well-formed OBB statics in a definition; malformed entries are skipped. */
export function parseObbStatics(definition: StreamDefinition): ObbStatic[] {
  const entries = definition.static_data;
  if (!Array.isArray(entries)) return [];
  const out: ObbStatic[] = [];
  for (const entry of entries) {
    if (!isObbEntry(entry)) continue;
    const v = entry.value as number[];
    out.push({
      targetFrame: entry.target_frame,
      referenceFrame: entry.reference_frame,
      center: [v[0], v[1], v[2]],
      quat: qNormalize([v[3], v[4], v[5], v[6]]),
      halfExtents: [v[7], v[8], v[9]],
    });
  }
  return out;
}

/** An OBB attached to a glove sensor (the glove-specific frame resolution). */
export interface GloveObb {
  sensorId: number;
  obb: ObbStatic;
}

/**
 * Map OBB target frames onto sensor ids; boxes on frames the glove model
 * doesn't know are dropped. An absent reference_frame is passed through:
 * resolveSensorId then reads `arm_sensor` as the local arm — the right frame
 * for an envelope riding the sensor — while an explicit coil_pro reference
 * anchors it to the streamed world pose.
 */
export function resolveGloveObbs(obbs: readonly ObbStatic[]): GloveObb[] {
  const out: GloveObb[] = [];
  for (const obb of obbs) {
    const sensorId = resolveSensorId(obb.targetFrame, obb.referenceFrame);
    if (sensorId !== null) out.push({ sensorId, obb });
  }
  return out;
}

// Unit cube (±1 corners) as 12 indexed edges, same layout as the C++
// bbox_renderer: scale by the half-extents at mount time to get the box.
// prettier-ignore
const CUBE_VERTS = new Float32Array([
  -1, -1, -1,
   1, -1, -1,
   1,  1, -1,
  -1,  1, -1,
  -1, -1,  1,
   1, -1,  1,
   1,  1,  1,
  -1,  1,  1,
]);

// prettier-ignore
const CUBE_EDGES = [
  0, 1, 1, 2, 2, 3, 3, 0, // back face
  4, 5, 5, 6, 6, 7, 7, 4, // front face
  0, 4, 1, 5, 2, 6, 3, 7, // connecting edges
];

/** Unit-cube edge geometry for lineSegments; one instance serves every box. */
export function createObbEdgesGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(CUBE_VERTS, 3));
  geometry.setIndex(CUBE_EDGES);
  return geometry;
}
