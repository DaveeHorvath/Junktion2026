// One sidecar joint overlay: the bone lines, per-joint markers, and axis
// triads drawn from a `rkk-hand-solver` group's world transforms. The OpenXR
// overlay is an instance of this; another format's would differ only in color,
// render order and marker sizing. What each frame convention *means* is
// documented in the per-format module (openxr-overlay.ts).
//
// Driven imperatively: HandRig calls the handle's `update` from its own
// useFrame so the overlay is posed after the solve and its visibility can be
// read back the same frame (the hand-mesh fade needs the overlay's state —
// see fadeMeshForOverlay). A useFrame of its own would race that ordering.

import { useMemo, useRef, useImperativeHandle, type Ref } from "react";
import type { Group } from "three";
import type { SolvedFrame } from "../compare/solved-frame.ts";
import { buildJointBones, updateJointBones } from "./joint-overlay.ts";

/** The slice of a recognized sidecar group the overlay draws. */
export interface SidecarJointGroup {
  jointNames: string[];
  parents: number[];
}

export interface SidecarOverlayHandle {
  /**
   * Pose the overlay from the matched frame's slot and return whether it is
   * on screen this frame. `frame` is null only before any frame for the group
   * has arrived — a transiently missing sibling falls back one frame upstream
   * (see frameAtOrBefore) precisely so this doesn't blink the overlay.
   */
  update(frame: SolvedFrame | null): boolean;
}

export function SidecarJointOverlay({
  ref,
  group,
  color,
  renderOrder,
  axisLength,
  radiusFor,
}: {
  ref: Ref<SidecarOverlayHandle>;
  group: SidecarJointGroup;
  color: string;
  renderOrder: number;
  /** Size of each joint's axis triad, in meters. */
  axisLength: number;
  /** Marker sphere scale per joint: published radii, or a constant. */
  radiusFor: (jointIndex: number) => number;
}) {
  const overlay = useMemo(() => buildJointBones(group.parents), [group]);
  const containerRef = useRef<Group>(null);
  const jointRefs = useRef<(Group | null)[]>([]);

  useImperativeHandle(
    ref,
    () => ({
      update(frame: SolvedFrame | null): boolean {
        const container = containerRef.current;
        if (!container) return false;
        container.visible = frame !== null;
        if (frame === null) return false;
        updateJointBones(overlay, frame);
        for (let j = 0; j < group.jointNames.length; j++) {
          const joint = jointRefs.current[j];
          if (!joint) continue;
          const p = j * 3;
          const r = j * 4;
          joint.position.set(frame.positions[p], frame.positions[p + 1], frame.positions[p + 2]);
          joint.quaternion.set(
            frame.rotations[r],
            frame.rotations[r + 1],
            frame.rotations[r + 2],
            frame.rotations[r + 3],
          );
        }
        return true;
      },
    }),
    [overlay, group],
  );

  return (
    <group ref={containerRef} visible={false}>
      <lineSegments geometry={overlay.geometry} frustumCulled={false} renderOrder={renderOrder}>
        <lineBasicMaterial color={color} depthTest={false} />
      </lineSegments>
      {group.jointNames.map((name, j) => (
        <group
          key={name}
          ref={(el) => {
            jointRefs.current[j] = el;
          }}
        >
          {/* Translucent and depth-write-free: the marker must annotate the
              hand, not occlude it. */}
          <mesh scale={radiusFor(j)}>
            <sphereGeometry args={[1, 12, 10]} />
            <meshBasicMaterial color={color} transparent opacity={0.16} depthWrite={false} />
          </mesh>
          <axesHelper args={[axisLength]} />
        </group>
      ))}
    </group>
  );
}
