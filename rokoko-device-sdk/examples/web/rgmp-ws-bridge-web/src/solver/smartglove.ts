// Smartgloves stream interpretation (pure, framework-free).
//
// Recognizes a glove from its stream definition and reads its per-sensor
// orientations, so the 3D view can drive the solver from a live device.
//
// Smartgloves II stream 8 sensors, identified on the wire by
// (target_frame, reference_frame, measure_type). The triple matters:
// `arm_sensor` appears twice — relative to `hub` (local arm pose) and
// relative to `coil_pro` (world-anchored arm pose) — and they are distinct
// sensors. Quaternions are FLOAT[4] in x,y,z,w order; TRANSFORM streams are
// FLOAT[7] position-then-quaternion.

import type { DecodedStream, StreamDefinition, StreamValue } from "../protocol/rgmp-layout.ts";
import { isBitSet } from "../protocol/status-flags.ts";

// Sensor ids (index into the per-sensor arrays throughout the solver).
export const THUMB_FINGER_ID = 0;
export const INDEX_FINGER_ID = 1;
export const MIDDLE_FINGER_ID = 2;
export const RING_FINGER_ID = 3;
export const LITTLE_FINGER_ID = 4;
export const ARM_SENSOR_ID = 5;
export const HUB_SENSOR_ID = 6;
export const ARM_IN_WORLD_SENSOR_ID = 7;
export const SENSOR_COUNT = 8;

export const SENSOR_NAMES: readonly string[] = [
  "thumb",
  "index",
  "middle",
  "ring",
  "little",
  "arm",
  "hub",
  "arm (Coil Pro)",
];

/** Wire name of the STATUS_FLAGS bit reporting valid sensor data. */
export const IS_DATA_VALID_FLAG = "is_data_valid";

/** Wire name of the STATUS_FLAGS bit reporting a Coil Pro present. */
export const IS_COIL_PRO_PRESENT_FLAG = "is_coil_pro_present";

/** The bit indices the solver keys on, resolved per bit_mapping. */
interface FlagBits {
  dataValid: number;
  coilPresent: number;
}

// The fixed indices from the reference client — the decoding before
// definitions carried a bit_mapping, kept as the fallback when a mapping is
// absent or lacks the name (tools/mock-driver.mjs names only bit 0).
const FALLBACK_FLAG_BITS: FlagBits = { dataValid: 0, coilPresent: 9 };

// bit_mapping objects are decoded once per definition and aliased by every
// frame's DecodedStream, so resolving by name caches on the mapping's
// identity — the per-frame path then does no string scanning.
const flagBitsCache = new WeakMap<Record<string, string>, FlagBits>();

/**
 * The solver's flag-bit indices for one STATUS_FLAGS stream, looked up by
 * NAME through the definition's bit_mapping — so the decoding survives
 * firmware moving a flag to a different bit — with the historical fixed
 * indices as the fallback.
 */
function flagBitsFor(bitMapping: Record<string, string> | undefined): FlagBits {
  if (bitMapping === undefined) return FALLBACK_FLAG_BITS;
  let bits = flagBitsCache.get(bitMapping);
  if (bits === undefined) {
    bits = { ...FALLBACK_FLAG_BITS };
    for (const [bit, name] of Object.entries(bitMapping)) {
      if (name === IS_DATA_VALID_FLAG) bits.dataValid = Number(bit);
      else if (name === IS_COIL_PRO_PRESENT_FLAG) bits.coilPresent = Number(bit);
    }
    flagBitsCache.set(bitMapping, bits);
  }
  return bits;
}

// Quaternion primitives live in math.ts (shared with the solver);
// re-exported here for consumers of the glove model. Wire order is x,y,z,w.
import { qMul, type Quat } from "./math.ts";
export { QUAT_IDENTITY } from "./math.ts";
export type { Quat } from "./math.ts";

export function isSmartglove(definition: StreamDefinition): boolean {
  return definition.device_type?.toLowerCase().includes("smartglove") ?? false;
}

/**
 * Laterality: Smartgloves II emits `device_info.hand = "left"|"right"`; the
 * v1 adapter emits `is_right_glove`. Prefer the former. Defaults to left.
 */
export function detectIsRight(definition: StreamDefinition): boolean {
  const info = definition.device_info;
  if (typeof info !== "object" || info === null) return false;
  const { hand, is_right_glove } = info as Record<string, unknown>;
  if (typeof hand === "string") {
    if (hand.toLowerCase() === "right") return true;
    if (hand.toLowerCase() === "left") return false;
  }
  return is_right_glove === true;
}

/**
 * Map a stream's frames to a sensor id, or null if it isn't a glove sensor.
 *
 * A sensor and the IMU inside it are one sensor: a glove names them
 * `<part>_sensor` and `<part>_imu`, and both resolve to the same id. Which
 * measure is being read is what tells them apart, not the frame.
 *
 * Handles both the snake_case frame names and the v1-adapter CamelCase
 * fallbacks ("Thumb Finger", "Glove Hub", …).
 */
export function resolveSensorId(targetFrame: string, referenceFrame?: string): number | null {
  const target = targetFrame.toLowerCase();
  if (target.includes("thumb_finger") || target.includes("thumb finger")) return THUMB_FINGER_ID;
  if (target.includes("index_finger") || target.includes("index finger")) return INDEX_FINGER_ID;
  if (target.includes("middle_finger") || target.includes("middle finger")) return MIDDLE_FINGER_ID;
  if (target.includes("ring_finger") || target.includes("ring finger")) return RING_FINGER_ID;
  if (target.includes("little_finger") || target.includes("little finger")) return LITTLE_FINGER_ID;

  // Arm sensor, disambiguated by reference frame: relative to coil_pro it is
  // the world-anchored arm pose, otherwise the local arm sensor.
  if (target.includes("arm_sensor") || target === "arm" || target === "arm_imu") {
    return (referenceFrame ?? "").toLowerCase().includes("coil_pro")
      ? ARM_IN_WORLD_SENSOR_ID
      : ARM_SENSOR_ID;
  }

  if (target === "hub" || target === "hub_imu" || target.includes("glove hub")) {
    return HUB_SENSOR_ID;
  }

  // v1-only: world-anchored arm pose as a distinct target frame.
  if (target.includes("glove coil sensor")) return ARM_IN_WORLD_SENSOR_ID;

  return null;
}

function isOrientationLike(measureType: string): boolean {
  return measureType === "ORIENTATION" || measureType === "TRANSFORM";
}

/**
 * The custom_label identifying a per-sensor relative EMF residual stream:
 * the residual between measured and model-expected EMF, as a percentage of
 * the expected magnitude (0 = perfect, unbounded above 100%). Coil Pro only.
 */
export const EMF_RESIDUAL_LABEL = "relative_emf_residual";

/** A glove device as derived from its stream definition (static per device). */
export interface GloveDescriptor {
  deviceId: number;
  isRight: boolean;
  /** Group holding the sensor streams (the first group that has any). */
  sensorGroupId: number;
  /** Sensor ids present in the definition, ascending. */
  sensorIds: number[];
  /**
   * Every group carrying relative_emf_residual CUSTOM streams, ascending;
   * empty when the device has none (Smartgloves I, or no Coil Pro tracking).
   * Real gloves split them: the world-arm residual rides in the motion group
   * while the per-finger residuals live in a separate `emf_only` group.
   */
  emfGroupIds: number[];
  /** Sensor ids with a residual stream in any group, ascending. */
  emfSensorIds: number[];
}

/**
 * Recognize a glove device and locate its sensor streams. Returns null when
 * the device isn't a smartglove or exposes no resolvable orientation streams.
 *
 * The EMF residual streams are collected across ALL groups: real gloves
 * scatter them (the world-arm residual sits in the motion group, the finger
 * residuals in `emf_only`), and group order isn't guaranteed. Residual
 * streams are matched by measure type + label, not by frame name alone:
 * resolveSensorId's substring matching is loose (see TODO.md §3), so the
 * explicit CUSTOM gate keeps unrelated streams out.
 */
export function describeGlove(definition: StreamDefinition): GloveDescriptor | null {
  if (!isSmartglove(definition)) return null;
  const groups = definition.groups ?? [];

  let sensorGroupId: number | null = null;
  let sensorIds: number[] = [];
  const emfGroupIds: number[] = [];
  const emfSensorIds = new Set<number>();

  for (let groupId = 0; groupId < groups.length; groupId++) {
    const ids = new Set<number>();
    let hasResidual = false;
    for (const stream of groups[groupId].streams ?? []) {
      const orientationLike = isOrientationLike(stream.measure_type);
      const emfResidual =
        stream.measure_type === "CUSTOM" && stream.custom_label === EMF_RESIDUAL_LABEL;
      if (!orientationLike && !emfResidual) continue;
      const id = resolveSensorId(stream.target_frame, stream.reference_frame);
      if (id === null) continue;
      if (orientationLike) ids.add(id);
      else {
        hasResidual = true;
        emfSensorIds.add(id);
      }
    }
    if (sensorGroupId === null && ids.size > 0) {
      sensorGroupId = groupId;
      sensorIds = [...ids].sort((a, b) => a - b);
    }
    if (hasResidual) emfGroupIds.push(groupId);
  }

  if (sensorGroupId === null) return null;
  return {
    deviceId: definition.device_id,
    isRight: detectIsRight(definition),
    sensorGroupId,
    sensorIds,
    emfGroupIds,
    emfSensorIds: [...emfSensorIds].sort((a, b) => a - b),
  };
}

/** One frame's worth of glove sensor state, indexed by sensor id. */
export interface GloveSample {
  /** Orientation quaternions (x,y,z,w) in the device's source frame. */
  quats: (Quat | null)[];
  /** Hub-space positions from TRANSFORM streams (null for ORIENTATION-only). */
  positions: (readonly [number, number, number] | null)[];
  /** Raw STATUS_FLAGS words, where present. Not truncated: may be bigint. */
  flags: (StreamValue | null)[];
  /** Decoded is_data_valid per sensor; null where no flags arrived. */
  dataValid: (boolean | null)[];
  /** Decoded is_coil_pro_present per sensor; null where no flags arrived. */
  coilPresent: (boolean | null)[];
}

/**
 * Preallocated backing for sampleGloveInto: the GloveSample plus fixed
 * per-sensor arrays that are swapped into it (or nulled out) each frame.
 * One per rig, created once — the per-frame sampling then allocates nothing.
 */
export interface GloveSampleScratch {
  sample: GloveSample;
  quatStore: [number, number, number, number][];
  posStore: [number, number, number][];
}

export function createGloveSampleScratch(): GloveSampleScratch {
  return {
    sample: {
      quats: new Array(SENSOR_COUNT).fill(null),
      positions: new Array(SENSOR_COUNT).fill(null),
      flags: new Array(SENSOR_COUNT).fill(null),
      dataValid: new Array(SENSOR_COUNT).fill(null),
      coilPresent: new Array(SENSOR_COUNT).fill(null),
    },
    quatStore: Array.from({ length: SENSOR_COUNT }, () => [0, 0, 0, 1]),
    posStore: Array.from({ length: SENSOR_COUNT }, () => [0, 0, 0]),
  };
}

/** sampleGlove into caller-owned scratch — see GloveSampleScratch. */
export function sampleGloveInto(
  streams: readonly DecodedStream[],
  scratch: GloveSampleScratch,
): GloveSample {
  const { sample, quatStore, posStore } = scratch;
  sample.quats.fill(null);
  sample.positions.fill(null);
  sample.flags.fill(null);
  sample.dataValid.fill(null);
  sample.coilPresent.fill(null);

  for (const stream of streams) {
    const id = resolveSensorId(stream.targetFrame, stream.referenceFrame);
    if (id === null) continue;
    const v = stream.values;

    if (stream.measureType === "ORIENTATION" && v.length >= 4) {
      const q = quatStore[id];
      q[0] = Number(v[0]);
      q[1] = Number(v[1]);
      q[2] = Number(v[2]);
      q[3] = Number(v[3]);
      sample.quats[id] = q;
    } else if (stream.measureType === "TRANSFORM" && v.length >= 7) {
      const p = posStore[id];
      p[0] = Number(v[0]);
      p[1] = Number(v[1]);
      p[2] = Number(v[2]);
      sample.positions[id] = p;
      const q = quatStore[id];
      q[0] = Number(v[3]);
      q[1] = Number(v[4]);
      q[2] = Number(v[5]);
      q[3] = Number(v[6]);
      sample.quats[id] = q;
    } else if (stream.measureType === "STATUS_FLAGS" && v.length >= 1) {
      // Decoded here rather than by the consumers: the bit_mapping that names
      // the bits rides on the stream, which checks like isSensorInvalid no
      // longer see. isBitSet keeps a >32-bit (bigint) flag word readable.
      const bits = flagBitsFor(stream.bitMapping);
      sample.flags[id] = v[0];
      sample.dataValid[id] = isBitSet(v[0], bits.dataValid);
      sample.coilPresent[id] = isBitSet(v[0], bits.coilPresent);
    }
  }

  return sample;
}

/**
 * Extract per-sensor orientations, positions, and flags from a decoded group.
 * The allocating form, for readability and tests; the per-frame render path
 * calls sampleGloveInto with per-rig scratch instead.
 */
export function sampleGlove(streams: readonly DecodedStream[]): GloveSample {
  return sampleGloveInto(streams, createGloveSampleScratch());
}

/** Per-rig scratch for sampleEmfResidualsInto: SENSOR_COUNT slots. */
export function createEmfResidualScratch(): (number | null)[] {
  return new Array<number | null>(SENSOR_COUNT).fill(null);
}

/**
 * Latest per-sensor relative EMF residual (%) by sensor id; null where no
 * group carries a residual for that sensor. Takes one stream array per
 * decoded group because the residuals span groups on real gloves (see
 * GloveDescriptor.emfGroupIds). Streams are matched by CUSTOM measure type +
 * the residual label (see EMF_RESIDUAL_LABEL) before frame resolution,
 * mirroring describeGlove. Zero-alloc: fills the caller-owned `out` in
 * place, like sampleGloveInto.
 */
export function sampleEmfResidualsInto(
  streamGroups: readonly (readonly DecodedStream[])[],
  out: (number | null)[],
): (number | null)[] {
  out.fill(null);
  for (const streams of streamGroups) {
    for (const stream of streams) {
      if (stream.measureType !== "CUSTOM") continue;
      if (stream.label !== EMF_RESIDUAL_LABEL || stream.values.length < 1) continue;
      const id = resolveSensorId(stream.targetFrame, stream.referenceFrame);
      if (id !== null) out[id] = Number(stream.values[0]);
    }
  }
  return out;
}

/** True when the sensor's flags report a Coil Pro present. */
export function isCoilPresent(sample: GloveSample, sensorId: number): boolean {
  return sample.coilPresent[sensorId] === true;
}

/**
 * True when this frame's streams report a Coil Pro: the is_coil_pro_present
 * flag of the world-anchored arm sensor's STATUS_FLAGS — the same signal the
 * finger solver's world anchoring keys on (see finger-poser.ts). A direct
 * stream scan rather than a full sampleGloveInto, so presence-only consumers
 * (the Coil Pro model in the scene) don't need per-frame sample scratch.
 */
export function sampleCoilPresence(streams: readonly DecodedStream[]): boolean {
  for (const stream of streams) {
    if (stream.measureType !== "STATUS_FLAGS" || stream.values.length < 1) continue;
    if (resolveSensorId(stream.targetFrame, stream.referenceFrame) !== ARM_IN_WORLD_SENSOR_ID) {
      continue;
    }
    if (isBitSet(stream.values[0], flagBitsFor(stream.bitMapping).coilPresent)) return true;
  }
  return false;
}

/** True when the sensor's flags are present and report invalid data. */
export function isSensorInvalid(sample: GloveSample, sensorId: number): boolean {
  return sample.dataValid[sensorId] === false;
}

/**
 * A sensor's display orientation: finger and arm sensors are relative to the
 * hub, so compose with the hub's own orientation; the hub and the
 * world-anchored arm pose pass through unchanged.
 */
export function sensorWorldQuat(sample: GloveSample, sensorId: number): Quat | null {
  const q = sample.quats[sensorId];
  if (q === null) return null;
  if (sensorId === HUB_SENSOR_ID || sensorId === ARM_IN_WORLD_SENSOR_ID) return q;
  const hub = sample.quats[HUB_SENSOR_ID];
  return hub ? qMul(hub, q) : q;
}

// Everything above stays in the glove's own sensor frame. There is no
// per-value conversion to three.js: the whole device→three.js rebasing is one
// rotation applied to the entire solved skeleton at the rig's render-graph
// parent (DEVICE_TO_THREE_ROTATION in scene/HandRig.tsx).
