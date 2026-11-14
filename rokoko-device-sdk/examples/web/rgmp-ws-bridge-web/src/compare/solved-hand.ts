// Recognizing the `rkk-hand-solver` sidecar's devices from their stream
// definitions: which device is a solved hand, which streams carry its joints,
// and each group's joint order and hierarchy. Static per device — the per-frame
// side lives in solved-frame.ts.
//
// # Why any of this exists
//
// `rkk-hand-solver` is a sidecar carrying a Rust port of `src/solver/`, served
// as RGMP v2. That port is pinned to the same fixtures
// this app's solver is, but fixtures don't cover real hardware — coil
// transitions, dropouts, both hands at once. Connecting the viewer to both the
// driver and the sidecar and overlaying the two skeletons does, and it
// exercises the whole wire path (definition, encode, decode) at the same time.

import type { StreamDefinition } from "../protocol/rgmp-layout.ts";

/** The device type `rkk-hand-solver` announces its synthetic hands as. */
export const SOLVED_DEVICE_TYPE = "solved_hand";

/** The group carrying per-joint world transforms (the sidecar's `--emit world`). */
export const WORLD_GROUP_NAME = "joints_world";

/** The OpenXR-formatted group (the sidecar's `--emit-openxr`). */
export const OPENXR_GROUP_NAME = "joints_openxr";

/** The custom_label of the per-joint radius entries in static_data. */
export const OPENXR_RADIUS_LABEL = "joint_radius";

/** Fallback radius (m) when a joint's static_data entry is missing/unreadable. */
const OPENXR_DEFAULT_RADIUS = 0.008;

/** A solved-hand device as derived from its stream definition (static per device). */
export interface SolvedHandDescriptor {
  deviceId: number;
  isRight: boolean;
  /** Group id of the world-transform group. */
  worldGroupId: number;
  /**
   * Newton joint names in *stream* order — the order values arrive in, which is
   * what a decoded frame must be read against.
   */
  jointNames: string[];
  /** Parent index per joint (into `jointNames`), -1 for the root. */
  parents: number[];
  /**
   * Where joint `i` sits in the group's decoded stream array. Not simply `i`:
   * only TRANSFORM streams are joints, so anything else the group carries would
   * otherwise shift every joint after it.
   */
  streamIndex: number[];
  /** The `joints_openxr` group, when the sidecar was run with `--emit-openxr`. */
  openxr: OpenXrGroup | null;
}

/**
 * The sidecar's OpenXR-formatted group: the 26 `XrHandJointEXT` joints as
 * world transforms in the Y-up `xr_base` frame, rebased and re-oriented by
 * the `rkk-hand-solver` sidecar's own OpenXR emitter (a Rokoko-internal tool,
 * not part of the SDK). Unlike `joints_world` these arrive *already rebased*
 * out of the device frame, which is exactly what the visual check exploits —
 * see scene/openxr-overlay.ts.
 */
export interface OpenXrGroup {
  groupId: number;
  /** Joint names in stream order, `xr_` prefix stripped: "palm", "wrist", …. */
  jointNames: string[];
  /** Parent index per joint (into `jointNames`), -1 for the wrist root. */
  parents: number[];
  /** Where joint `i` sits in the group's decoded stream array. */
  streamIndex: number[];
  /** Per-joint radius in meters, from the `joint_radius` static_data entries. */
  radii: number[];
}

interface JointInfo {
  frame?: unknown;
  name?: unknown;
  parent?: unknown;
}

/**
 * Recognize a solved hand and work out its joint order and hierarchy, or return
 * null when the device isn't one (or carries no world group we can read).
 *
 * Stream order is taken from the group's stream list, not from
 * `device_info.joints` — the streams are what the packed values are laid out
 * against, so they are authoritative. `device_info` supplies only the Newton
 * name and parent for each `target_frame`, looked up by frame. The emitter
 * happens to publish both in the same order, and this does not rely on it.
 */
export function describeSolvedHand(definition: StreamDefinition): SolvedHandDescriptor | null {
  if (definition.device_type !== SOLVED_DEVICE_TYPE) return null;

  const groups = definition.groups ?? [];
  const worldGroupId = groups.findIndex((g) => g.name === WORLD_GROUP_NAME);
  if (worldGroupId < 0) return null;

  const streams = groups[worldGroupId].streams ?? [];
  const order: string[] = [];
  const streamIndex: number[] = [];
  streams.forEach((s, i) => {
    if (s.measure_type !== "TRANSFORM") return;
    order.push(s.target_frame);
    streamIndex.push(i);
  });
  if (order.length === 0) return null;

  const info = definition.device_info;
  const joints = (
    typeof info === "object" && info !== null ? (info as { joints?: unknown }).joints : undefined
  ) as JointInfo[] | undefined;
  if (!Array.isArray(joints)) return null;

  // frame -> Newton name, and frame -> parent frame.
  const names = new Map<string, string>();
  const parentFrames = new Map<string, string | null>();
  for (const joint of joints) {
    if (typeof joint?.frame !== "string") continue;
    names.set(joint.frame, typeof joint.name === "string" ? joint.name : joint.frame);
    parentFrames.set(joint.frame, typeof joint.parent === "string" ? joint.parent : null);
  }

  const slot = new Map(order.map((frame, i) => [frame, i]));
  const jointNames: string[] = [];
  const parents: number[] = [];
  for (const frame of order) {
    jointNames.push(names.get(frame) ?? frame);
    const parentFrame = parentFrames.get(frame) ?? null;
    parents.push(parentFrame === null ? -1 : (slot.get(parentFrame) ?? -1));
  }

  return {
    deviceId: definition.device_id,
    isRight: solvedHandIsRight(definition),
    worldGroupId,
    jointNames,
    parents,
    streamIndex,
    openxr: describeOpenXrGroup(definition),
  };
}

/**
 * The joint order, hierarchy, and stream slots of one named sidecar group:
 * stream order is authoritative (as for the world group), names lose
 * `stripPrefix`, and the hierarchy is derived from the names via `parentOf`,
 * since the topology is fixed by the convention rather than published per
 * device.
 */
function describeJointGroup(
  definition: StreamDefinition,
  groupName: string,
  stripPrefix: RegExp,
  parentOf: (name: string) => string | null,
): { groupId: number; jointNames: string[]; parents: number[]; streamIndex: number[] } | null {
  const groups = definition.groups ?? [];
  const groupId = groups.findIndex((g) => g.name === groupName);
  if (groupId < 0) return null;

  const jointNames: string[] = [];
  const streamIndex: number[] = [];
  (groups[groupId].streams ?? []).forEach((s, i) => {
    if (s.measure_type !== "TRANSFORM") return;
    jointNames.push(s.target_frame.replace(stripPrefix, ""));
    streamIndex.push(i);
  });
  if (jointNames.length === 0) return null;

  return { groupId, jointNames, parents: parentsByName(jointNames, parentOf), streamIndex };
}

/**
 * Parent indices resolved against the published names, so a reordered stream
 * list cannot scramble the bones. A joint whose parent name isn't in the list
 * gets -1 (drawn as an unconnected point rather than a wrong bone).
 */
function parentsByName(
  jointNames: readonly string[],
  parentOf: (name: string) => string | null,
): number[] {
  const slot = new Map(jointNames.map((name, i) => [name, i]));
  return jointNames.map((name) => {
    const parent = parentOf(name);
    return parent === null ? -1 : (slot.get(parent) ?? -1);
  });
}

/**
 * Recognize the `joints_openxr` group, or return null when the sidecar wasn't
 * run with `--emit-openxr`.
 */
export function describeOpenXrGroup(definition: StreamDefinition): OpenXrGroup | null {
  const group = describeJointGroup(definition, OPENXR_GROUP_NAME, /^xr_/, openxrParentName);
  if (group === null) return null;

  // Radii travel once in static_data as CUSTOM/joint_radius entries keyed by
  // the same xr_* target frames. Treated as untrusted, like every definition
  // field: a missing or non-finite value falls back rather than poisoning the
  // sphere scale.
  const radiusByFrame = new Map<string, number>();
  for (const entry of definition.static_data ?? []) {
    if (entry.measure_type !== "CUSTOM" || entry.custom_label !== OPENXR_RADIUS_LABEL) continue;
    const value: unknown = entry.value;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      radiusByFrame.set(entry.target_frame, value);
    }
  }
  const radii = group.jointNames.map(
    (name) => radiusByFrame.get(`xr_${name}`) ?? OPENXR_DEFAULT_RADIUS,
  );

  return { ...group, radii };
}

/**
 * The fixed `XrHandJointEXT` topology, resolved against the published joint
 * names: the wrist is the root, the palm and the metacarpals hang off it, each
 * finger chains metacarpal → proximal → intermediate → distal → tip — except
 * the thumb, which has no intermediate.
 */
export function openxrParents(jointNames: readonly string[]): number[] {
  return parentsByName(jointNames, openxrParentName);
}

function openxrParentName(name: string): string | null {
  if (name === "wrist") return null;
  if (name === "palm") return "wrist";
  const split = name.lastIndexOf("_");
  if (split < 0) return null;
  const finger = name.slice(0, split);
  switch (name.slice(split + 1)) {
    case "metacarpal":
      return "wrist";
    case "proximal":
      return `${finger}_metacarpal`;
    case "intermediate":
      return `${finger}_proximal`;
    case "distal":
      return finger === "thumb" ? `${finger}_proximal` : `${finger}_intermediate`;
    case "tip":
      return `${finger}_distal`;
    default:
      return null;
  }
}

/** Laterality from `device_info.hand`; defaults to left, as the glove path does. */
function solvedHandIsRight(definition: StreamDefinition): boolean {
  const info = definition.device_info;
  if (typeof info !== "object" || info === null) return false;
  const { hand } = info as { hand?: unknown };
  return typeof hand === "string" && hand.toLowerCase() === "right";
}
