// A hand in the 3D scene: HandRig owns the per-frame solve, the anchoring
// (viewing slot / Coil Pro, heading yaw, device→three rebasing), the stick
// skeleton, and the solver-comparison ghost — and orchestrates the display
// subsystems, which live as sibling components:
//
//   - the skinned mesh, cut from newton.glb and driven by buildHandMesh/
//     driveMeshBones (newton-mesh.ts);
//   - SensorGizmos ("sensors" mode): labelled triads at the solved mounting
//     positions;
//   - AngleLabels ("angles" mode): per-joint readouts of the solver's local
//     euler angles (degrees, ZXY; flexion is x);
//   - EmfHalos / ObbBoxes: per-sensor diagnostic overlays, any display mode;
//   - SidecarJointOverlay: the sidecar's OpenXR joint set.
//
// The subsystems expose imperative update handles rather than their own
// useFrame: this file's single frame loop calls them after the solve, so
// every overlay reads the freshly solved skeleton and the mesh fade can read
// the sidecar overlay's visibility the same frame. Sibling useFrame ordering
// is subscription-order — not a contract to build on.
//
// Once per animation frame the rig runs solveFingers on the latest sensor
// sample; the solver pins the hub at the rig origin. Until the first sample is
// solved it shows the skeleton's rest pose.
//
// With `ghost`/`compareFrame` the rig also runs the solver comparison: instead
// of solving the newest sample it solves the newest sample the `rkk-hand-solver`
// sidecar has *also* solved, and draws the sidecar's skeleton over its own. See
// compare/pose-ring.ts for why the two must be matched by timestamp.

import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Vector3,
  type Group,
  type Mesh,
} from "three";
import type { LiveDevice } from "../protocol/rgmp.ts";
import { GLB_SCALE, NEWTON_GLB_URL, buildHandMesh, driveMeshBones } from "./newton-mesh.ts";
import {
  ARM_IN_WORLD_SENSOR_ID,
  createGloveSampleScratch,
  isCoilPresent,
  sampleGloveInto,
  type GloveDescriptor,
  type GloveSample,
} from "../solver/smartglove.ts";
import { Bone, HandSkeleton, poseFingersInHand, type HandSide } from "../solver/hand-skeleton.ts";
import { createGloveStateScratch, solveFingers, gloveStateInto } from "../solver/finger-poser.ts";
import { VEC3_UNIT_Y, VEC3_ZERO, angleAxis, qMul, vSub } from "../solver/math.ts";
import type { ComparedFrame } from "../compare/use-compare.ts";
import type { SolvedHandDescriptor } from "../compare/solved-hand.ts";
import type { ObbStatic } from "./obb-overlay.ts";
import { SensorGizmos, type SensorGizmosHandle } from "./SensorGizmos.tsx";
import { AngleLabels, type AngleLabelsHandle } from "./AngleLabels.tsx";
import { EmfHalos, type EmfHalosHandle } from "./EmfHalos.tsx";
import { ObbBoxes, type ObbBoxesHandle } from "./ObbBoxes.tsx";
import {
  GHOST_COLOR,
  GHOST_DASH,
  GHOST_RENDER_ORDER,
  READOUT_INTERVAL_MS,
  buildGhost,
  createDeltaPeak,
  foldDelta,
  formatPeak,
  formatWaiting,
  measureGhost,
  resetDeltaPeak,
  updateGhost,
} from "./ghost-overlay.ts";
import { fadeMeshForOverlay } from "./joint-overlay.ts";
import { SidecarJointOverlay, type SidecarOverlayHandle } from "./SidecarJointOverlay.tsx";
import { OPENXR_AXIS_LENGTH, OPENXR_COLOR, OPENXR_RENDER_ORDER } from "./openxr-overlay.ts";

// Device→three.js world-frame rebasing for live sensor data.
//
// The solver runs in the glove's sensor world frame (right-handed, +X right,
// +Y toward the wrist, +Z down — the frame the gloves are spec'd in), while
// three.js is right-handed Y-up (+Y up, +Z toward the viewer). Only one part of
// the conversion is physically determined, and it is the same for both hands
// (laterality is handled inside the solver):
//
//   +90° about X (DEVICE_TO_THREE_ROTATION) maps the gravity-down axis
//   (device +Z) onto three.js −Y (down). A proper rotation, so handedness is
//   preserved and a right glove stays a right hand.
//
// It must stay a rotation, never a mirror. Both frames are right-handed and a
// rotation preserves that; mirroring a single axis instead — an easy mistake
// when converting between frames, and one that also "works" for pitch and roll
// — would turn a physical right glove into a left hand on screen.
//
// Yaw is NOT fixed: the hub references it to magnetic north (it streams in
// LTP_NED), so the hands' heading in the scene depends on where north was at
// startup and how the screen is turned relative to it — neither of which the
// stream can tell us. The user resolves it once with "recenter" (V), which
// captures `headingOffset` — the yaw that points the forearms away from the
// camera (first-person POV); see SceneView.tsx. It is a rotation about the
// scene vertical, applied as the outermost group, outside this rebasing.
//
// Note that no constant yaw is baked in here. Recenter handles arbitrary yaw,
// which subsumes any fixed device-vs-scene offset; a constant added here would
// only have to be cancelled by the captured heading.
//
// Applied as wrapper groups: the whole solved skeleton — skinned mesh, stick
// overlay, and sensor gizmos alike — is a rigid result in device space, so
// rebasing its render-graph parent converts all of it consistently.
const DEVICE_TO_THREE_ROTATION: [number, number, number] = [Math.PI / 2, 0, 0];

/** What the rig shows besides the stick skeleton. */
export type HandDisplay = "mesh" | "sensors" | "angles";

/**
 * Reports the live forearm's heading as a scene-space XZ direction (elbow →
 * hand), with the fixed device→three.js rebasing applied but NOT the heading
 * offset. Returns null when there is no live data to measure. SceneView calls
 * this on "recenter" to derive the shared yaw. See `forearmHeadingXZ`.
 */
export type HeadingProbe = () => [number, number] | null;

/**
 * Reports the world-space bounding box of the rig's solved joints, or null
 * when there is no live pose to measure. SceneView unions these across rigs
 * on "frame gloves" (A) — the box is wherever the rig actually renders, slot-
 * or coil-anchored alike, since it is read off the scene graph.
 */
export type BoundsProbe = () => Box3 | null;

export function HandRig({
  side,
  position,
  display = "mesh",
  showEmf = false,
  showObb = false,
  showXr = false,
  obbs,
  glove,
  live,
  headingOffset = 0,
  registerHeadingProbe,
  registerBoundsProbe,
  ghost,
  compareFrame,
  compareReadout,
}: {
  side: HandSide;
  position: [number, number, number];
  display?: HandDisplay;
  /** Show the per-sensor EMF residual halos (see scene/emf-overlay.ts). */
  showEmf?: boolean;
  /** Show the sensor-envelope bounding boxes (see scene/obb-overlay.ts). */
  showObb?: boolean;
  /**
   * Show the sidecar's OpenXR joints (see scene/openxr-overlay.ts). Effective
   * only in comparison mode and when the sidecar runs with `--emit-openxr`.
   */
  showXr?: boolean;
  /** The device's baked OBB statics, parsed once per definition upstream. */
  obbs?: readonly ObbStatic[];
  glove: GloveDescriptor;
  live: () => ReadonlyMap<number, LiveDevice>;
  /** Shared yaw (radians, about scene +Y) aligning forearms to first-person. */
  headingOffset?: number;
  /** Registers/clears this rig's heading probe with the parent, keyed by id. */
  registerHeadingProbe?: (deviceId: number, probe: HeadingProbe | null) => void;
  /** Registers/clears this rig's bounds probe with the parent, keyed by id. */
  registerBoundsProbe?: (deviceId: number, probe: BoundsProbe | null) => void;
  /**
   * The sidecar's solved hand for this device, when one is streaming. Its
   * presence turns the comparison on: the overlay is drawn and the rig solves
   * matched frames rather than the newest one.
   */
  ghost?: SolvedHandDescriptor;
  /** The newest frame both solvers have for this device. */
  compareFrame?: () => ComparedFrame | null;
  /** Where to write this hand's comparison readout. */
  compareReadout?: RefObject<HTMLDivElement | null>;
}) {
  const jointRefs = useRef<(Mesh | null)[]>([]);
  // The display subsystems' imperative handles — see the header comment for
  // why they are driven from this component's frame loop.
  const gizmosHandle = useRef<SensorGizmosHandle>(null);
  const anglesHandle = useRef<AngleLabelsHandle>(null);
  const emfHandle = useRef<EmfHalosHandle>(null);
  const obbHandle = useRef<ObbBoxesHandle>(null);
  const gltf = useGLTF(NEWTON_GLB_URL);

  const rig = useMemo(() => {
    const skel = new HandSkeleton(side);
    poseFingersInHand(skel);
    skel.propagate();
    // Rest pose, shown until the first solved frame replaces it: anchored at
    // the rig origin. The glTF T-pose leaves hands at body coordinates pointing
    // sideways (left along +X), so translate to origin and yaw each side 90°
    // inward.
    const hand = skel.sidedBone(Bone.LEFT_HAND);
    const yaw = angleAxis(skel.isRight ? -90 : 90, VEC3_UNIT_Y);
    hand.alignRootTo(VEC3_ZERO, qMul(yaw, hand.rotation));

    // Skinned mesh cut from the glb (see newton-mesh.ts).
    const { meshes, material, forearmBone, branchBones } = buildHandMesh(gltf.scene, side);

    // ── Stick overlay geometry (initialized to the rest pose) ──────────────
    // Copies, not aliases: node positions are fixed arrays the solver rewrites
    // in place, and these values are retained past this pass (jointPositions
    // feeds the initial render).
    const rel = (i: number): [number, number, number] => {
      const p = skel.nodes[i].position;
      return [p[0], p[1], p[2]];
    };
    const segments: number[] = [];
    skel.joints.forEach((joint, i) => {
      if (joint.parent < 0) return;
      segments.push(...rel(joint.parent), ...rel(i));
    });
    const positionAttribute = new BufferAttribute(new Float32Array(segments), 3);
    positionAttribute.setUsage(DynamicDrawUsage);
    const boneGeometry = new BufferGeometry();
    boneGeometry.setAttribute("position", positionAttribute);
    const jointPositions = skel.nodes.map((_, i) => rel(i));

    driveMeshBones(branchBones, skel); // rest pose until the first solved frame

    return {
      skel,
      boneGeometry,
      positionAttribute,
      jointPositions,
      meshes,
      material,
      forearmBone,
      drive: () => driveMeshBones(branchBones, skel),
      // Per-rig scratch for the per-frame sample→state conversion, so the
      // solve allocates nothing on the way in.
      sampleScratch: createGloveSampleScratch(),
      stateScratch: createGloveStateScratch(),
    };
  }, [gltf, side]);

  // The sidecar's skeleton, paired against this rig's joints by name. Rebuilt
  // only when a solved hand appears, disappears, or re-announces itself.
  const overlay = useMemo(
    () =>
      ghost
        ? buildGhost(
            ghost,
            rig.skel.joints.map((j) => j.name),
          )
        : null,
    [ghost, rig],
  );

  // The sidecar's OpenXR joint set, when it emits one (--emit-openxr). Drawn
  // as a SidecarJointOverlay, posed through its imperative handle from the
  // frame loop.
  const xr = ghost?.openxr ?? null;
  const xrHandle = useRef<SidecarOverlayHandle>(null);

  // The comparison runs per frame but the readout is written at
  // READOUT_INTERVAL_MS with the worst value since the last write — see
  // READOUT_INTERVAL_MS for why the per-frame value is unreadable.
  const peak = useRef(createDeltaPeak());
  const nextWrite = useRef(0);

  // The viewing-slot placement and recenter yaw are artifice for hub-anchored
  // poses, whose origin is arbitrary. Once the solver world-anchors to a Coil
  // Pro (finger-poser step 4) the pose is in the coil_pro frame — the frame
  // the CoilRig model marks at the scene origin — so both must come off or
  // they would displace a position that is now physically meaningful. Presence
  // is per-frame (same STATUS_FLAGS bit the solver keys on), hence written
  // imperatively through these refs rather than through props.
  const slotGroupRef = useRef<Group>(null);
  const headingGroupRef = useRef<Group>(null);

  /** Replace the readout text, skipping the DOM write when it hasn't changed. */
  function writeReadout(text: string): void {
    const el = compareReadout?.current;
    if (el && el.textContent !== text) el.textContent = text;
  }

  useFrame(() => {
    // In comparison mode the pose comes from the newest frame *both* solvers
    // have — a couple of milliseconds behind live, and the only way the two
    // skeletons are answers to the same question. See compare/pose-ring.ts.
    const matched = compareFrame ? compareFrame() : null;
    let sample: GloveSample;
    if (compareFrame) {
      if (matched === null) {
        // Hold the last solved pose rather than snapping to the newest sample:
        // a pose the comparison can't vouch for would read as a solver
        // disagreement that isn't there.
        writeReadout(formatWaiting(side));
        return;
      }
      sample = matched.sample;
    } else {
      const streams = live().get(glove.deviceId)?.groups.get(glove.sensorGroupId)?.streams;
      if (!streams) return;
      sample = sampleGloveInto(streams, rig.sampleScratch);
    }

    // World-anchored frames render in the coil_pro frame at the scene origin;
    // hub-anchored frames in the viewing slot. Written every frame so a React
    // commit (which re-applies the JSX slot position) never sticks, and so the
    // rig falls back to its slot the moment coil tracking drops.
    const anchored = isCoilPresent(sample, ARM_IN_WORLD_SENSOR_ID);
    slotGroupRef.current?.position.set(
      anchored ? 0 : position[0],
      anchored ? 0 : position[1],
      anchored ? 0 : position[2],
    );
    if (headingGroupRef.current) {
      headingGroupRef.current.rotation.y = anchored ? 0 : headingOffset;
    }

    const { skel, positionAttribute } = rig;
    solveFingers(gloveStateInto(sample, glove.isRight, rig.stateScratch), skel);

    if (matched !== null && overlay !== null) {
      updateGhost(overlay, matched.solved);
      foldDelta(peak.current, measureGhost(overlay, matched.solved, skel.nodes), matched.lagMs);
      const now = performance.now();
      if (now >= nextWrite.current) {
        nextWrite.current = now + READOUT_INTERVAL_MS;
        writeReadout(formatPeak(side, peak.current));
        resetDeltaPeak(peak.current);
      }
    }

    if (display === "mesh") rig.drive();
    if (display === "sensors") gizmosHandle.current?.update(sample);
    if (display === "angles") anglesHandle.current?.update();
    if (showEmf) emfHandle.current?.update(sample);
    if (showObb) obbHandle.current?.update(sample);
    const xrVisible = showXr && (xrHandle.current?.update(matched?.openxr ?? null) ?? false);
    // Fade the hand mesh while the joint overlay is actually on screen, so its
    // joints aren't buried inside it; restore the moment it is gone. The
    // update above reports this frame's visibility.
    fadeMeshForOverlay(rig.material, xrVisible);

    // Live poses are anchored at the origin (the hub's, or the Coil Pro's when
    // world anchoring is in — the slot group above tracks which), and already
    // in the frame this group rebases, so world positions go in as-is. Written
    // component-wise:
    // per-joint arrays here were a measurable slice of the allocation churn.
    const arr = positionAttribute.array as Float32Array;
    let s = 0;
    skel.joints.forEach((joint, i) => {
      if (joint.parent < 0) return;
      const from = skel.nodes[joint.parent].position;
      const to = skel.nodes[i].position;
      arr[s] = from[0];
      arr[s + 1] = from[1];
      arr[s + 2] = from[2];
      arr[s + 3] = to[0];
      arr[s + 4] = to[1];
      arr[s + 5] = to[2];
      s += 6;
    });
    positionAttribute.needsUpdate = true;

    skel.nodes.forEach((node, i) => {
      const mesh = jointRefs.current[i];
      if (mesh) mesh.position.set(node.position[0], node.position[1], node.position[2]);
    });
  });

  // Measure the forearm's heading from the latest solved skeleton. The probe
  // reads the live pose at call time (the solver mutates rig.skel each frame),
  // so it must stay a fresh closure; a ref keeps the registered handle stable.
  const probeRef = useRef<HeadingProbe>(() => null);
  probeRef.current = () => {
    const { skel } = rig;
    // Forearm direction (elbow → hand) in the device frame.
    const v = vSub(
      skel.sidedBone(Bone.LEFT_HAND).position,
      skel.sidedBone(Bone.LEFT_LOWER_ARM).position,
    );
    // Rebasing through DEVICE_TO_THREE_ROTATION leaves, in the XZ (ground)
    // plane, the components as-is. The heading offset is deliberately excluded
    // so recenter recomputes an absolute yaw rather than a relative nudge.
    return [v[0], v[2]];
  };

  const deviceId = glove.deviceId;
  useEffect(() => {
    if (!registerHeadingProbe) return;
    registerHeadingProbe(deviceId, () => probeRef.current());
    return () => registerHeadingProbe(deviceId, null);
  }, [deviceId, registerHeadingProbe]);

  // World-space bounds of the solved pose, measured off the joint overlay
  // meshes: they track the pose in every display mode and sit inside the full
  // rebasing chain (slot/anchor, heading, device→three), so getWorldPosition
  // lands in scene space wherever the rig is anchored. User-triggered, so the
  // per-call allocations don't matter.
  const boundsRef = useRef<BoundsProbe>(() => null);
  boundsRef.current = () => {
    const box = new Box3();
    const v = new Vector3();
    for (const mesh of jointRefs.current) {
      if (mesh) box.expandByPoint(mesh.getWorldPosition(v));
    }
    return box.isEmpty() ? null : box;
  };

  useEffect(() => {
    if (!registerBoundsProbe) return;
    registerBoundsProbe(deviceId, () => boundsRef.current());
    return () => registerBoundsProbe(deviceId, null);
  }, [deviceId, registerBoundsProbe]);

  // The groups compose outermost-first: the shared heading yaw (about the scene
  // vertical), then the device→three.js rebasing (see above). Yawing each rig
  // about its own anchor (not all gloves in one group) keeps the left/right
  // viewing slots fixed while turning each hand to face the user.
  return (
    <group ref={slotGroupRef} position={position}>
      <group ref={headingGroupRef} rotation={[0, headingOffset, 0]}>
        <group rotation={DEVICE_TO_THREE_ROTATION}>
          {display === "mesh" && (
            <>
              {rig.forearmBone && (
                <group scale={GLB_SCALE}>
                  <primitive object={rig.forearmBone} />
                </group>
              )}
              {rig.meshes.map((m, i) => (
                <primitive key={i} object={m} />
              ))}
            </>
          )}
          <lineSegments geometry={rig.boneGeometry} frustumCulled={false}>
            <lineBasicMaterial color="#4f8cff" />
          </lineSegments>
          {/* The sidecar's skeleton, in the same space as the one above. Dashed
              and depth-free so coincident agreement is still legible and the
              overlay shows in every display mode — see GHOST_DASH. */}
          {overlay && (
            <lineSegments
              geometry={overlay.geometry}
              frustumCulled={false}
              renderOrder={GHOST_RENDER_ORDER}
            >
              <lineDashedMaterial
                color={GHOST_COLOR}
                dashSize={GHOST_DASH.size}
                gapSize={GHOST_DASH.gap}
                depthTest={false}
              />
            </lineSegments>
          )}
          {rig.jointPositions.map((p, i) => (
            <mesh
              key={i}
              position={p}
              ref={(el) => {
                jointRefs.current[i] = el;
              }}
            >
              <sphereGeometry args={[0.0035, 12, 8]} />
              <meshStandardMaterial color="#e4e7ee" />
            </mesh>
          ))}
          {display === "sensors" && (
            <SensorGizmos ref={gizmosHandle} glove={glove} skel={rig.skel} />
          )}
          {showObb && <ObbBoxes ref={obbHandle} glove={glove} skel={rig.skel} obbs={obbs ?? []} />}
          {showEmf && glove.emfGroupIds.length > 0 && (
            <EmfHalos ref={emfHandle} glove={glove} live={live} skel={rig.skel} />
          )}
          {display === "angles" && (
            <AngleLabels ref={anglesHandle} skel={rig.skel} jointPositions={rig.jointPositions} />
          )}
        </group>
        {/* The sidecar's OpenXR joints. Deliberately a SIBLING of the
            device→three group above, not a child: joints_openxr is already
            rebased to the Y-up xr_base frame by the sidecar's own +90°-about-X,
            so it mounts un-rotated. Landing exactly on the (rotated) hand is
            the check — see openxr-overlay.ts (which also explains the triads:
            +Z back along the bone, +Y dorsal / out the nail). The heading yaw
            and viewing slot still apply: they are scene artifice shared by
            both frames. Marker spheres scale by the published joint_radius, so
            the radii themselves are inspectable. */}
        {showXr && xr && (
          <SidecarJointOverlay
            ref={xrHandle}
            group={xr}
            color={OPENXR_COLOR}
            renderOrder={OPENXR_RENDER_ORDER}
            axisLength={OPENXR_AXIS_LENGTH}
            radiusFor={(j) => xr.radii[j]}
          />
        )}
      </group>
    </group>
  );
}
