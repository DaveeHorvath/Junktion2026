// The "sensors" display mode: one labelled triad per sensor, placed at its
// solved mounting position on the hand.
//
// Placement: a sensor's world orientation is hub∘sensor (the hub streams in
// world frame, the others relative to it), and its position follows from the
// solver's own mounting relation — the driven bone sits at sensorPos +
// R·(-offset), so the sensor sits at bonePos + R·offset, with the hub's
// offset applied from the hand bone exactly as the solver does. Once a Coil Pro
// anchors the skeleton, those orientations are rotated with it, so the triads
// stay on the hand and the arm and arm (Coil Pro) triads coincide. The math is
// sensorPoseOnSkeleton (sensor-placement.ts), shared with the EMF halos and
// OBB boxes so all three place identically.
//
// Driven imperatively: HandRig calls `update` from its useFrame after the
// solve, since the placement reads the freshly solved skeleton.

import { useRef, useImperativeHandle, type Ref } from "react";
import { Billboard, Text } from "@react-three/drei";
import type { Group, MeshStandardMaterial } from "three";
import {
  SENSOR_NAMES,
  isSensorInvalid,
  type GloveDescriptor,
  type GloveSample,
} from "../solver/smartglove.ts";
import type { HandSkeleton } from "../solver/hand-skeleton.ts";
import {
  COLOR_INVALID,
  COLOR_MUTED,
  anchorRotation,
  sensorPoseOnSkeleton,
} from "./sensor-placement.ts";

export interface SensorGizmosHandle {
  /** Place each sensor triad at its solved mounting position on the hand. */
  update(sample: GloveSample): void;
}

export function SensorGizmos({
  ref,
  glove,
  skel,
}: {
  ref: Ref<SensorGizmosHandle>;
  glove: GloveDescriptor;
  /** The rig's skeleton, mutated in place by the per-frame solve. */
  skel: HandSkeleton;
}) {
  const gizmoRefs = useRef<(Group | null)[]>([]);
  const gizmoRotRefs = useRef<(Group | null)[]>([]);
  const gizmoMatRefs = useRef<(MeshStandardMaterial | null)[]>([]);

  useImperativeHandle(
    ref,
    () => ({
      update(sample: GloveSample): void {
        const anchor = anchorRotation(skel, sample);
        for (const id of glove.sensorIds) {
          const gizmo = gizmoRefs.current[id];
          if (!gizmo) continue;

          const pose = sensorPoseOnSkeleton(skel, sample, id, glove.isRight, anchor);
          gizmo.visible = pose !== null;
          if (pose === null) continue;
          const { position: pos, rotation: q } = pose;
          // Device-frame values written straight in; the parent group rebases them.
          gizmo.position.set(pos[0], pos[1], pos[2]);
          const rot = gizmoRotRefs.current[id];
          if (rot) rot.quaternion.set(q[0], q[1], q[2], q[3]);

          const mat = gizmoMatRefs.current[id];
          if (mat) mat.color.set(isSensorInvalid(sample, id) ? COLOR_INVALID : COLOR_MUTED);
        }
      },
    }),
    [glove, skel],
  );

  return (
    <>
      {glove.sensorIds.map((id) => (
        <group
          key={id}
          visible={false}
          ref={(el) => {
            gizmoRefs.current[id] = el;
          }}
        >
          <group
            ref={(el) => {
              gizmoRotRefs.current[id] = el;
            }}
          >
            <axesHelper args={[0.022]} />
            <mesh>
              <boxGeometry args={[0.009, 0.009, 0.009]} />
              <meshStandardMaterial
                ref={(el) => {
                  gizmoMatRefs.current[id] = el;
                }}
                color={COLOR_MUTED}
              />
            </mesh>
          </group>
          <Billboard position={[0, -0.018, 0]}>
            <Text fontSize={0.009} color={COLOR_MUTED}>
              {SENSOR_NAMES[id]}
            </Text>
          </Billboard>
        </group>
      ))}
    </>
  );
}
