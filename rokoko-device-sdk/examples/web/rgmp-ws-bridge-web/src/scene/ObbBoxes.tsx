// Sensor-envelope boxes: the device's advertised physical extents riding the
// solved sensor poses, independent of the display mode. The group carries the
// composed world pose (written per frame); the half-extents are static, so
// the scale stays declarative.
//
// Driven imperatively: HandRig calls `update` from its useFrame after the
// solve, since box placement reads the freshly solved skeleton.

import { useMemo, useRef, useImperativeHandle, type Ref } from "react";
import type { Group } from "three";
import type { GloveDescriptor, GloveSample } from "../solver/smartglove.ts";
import type { HandSkeleton } from "../solver/hand-skeleton.ts";
import { qMul, vAdd, vTransform } from "../solver/math.ts";
import {
  OBB_COLOR,
  createObbEdgesGeometry,
  resolveGloveObbs,
  type ObbStatic,
} from "./obb-overlay.ts";
import { anchorRotation, sensorPoseOnSkeleton } from "./sensor-placement.ts";

export interface ObbBoxesHandle {
  /** Pose each box from the solved sensor poses. */
  update(sample: GloveSample): void;
}

export function ObbBoxes({
  ref,
  glove,
  skel,
  obbs,
}: {
  ref: Ref<ObbBoxesHandle>;
  glove: GloveDescriptor;
  /** The rig's skeleton, mutated in place by the per-frame solve. */
  skel: HandSkeleton;
  /** The device's baked OBB statics, parsed once per definition upstream. */
  obbs: readonly ObbStatic[];
}) {
  // Frame→sensor resolution happens once per definition; per frame only the
  // pose composition runs. One unit-cube geometry serves every box; each box
  // is that cube scaled by its half-extents.
  const gloveObbs = useMemo(() => resolveGloveObbs(obbs), [obbs]);
  const geometry = useMemo(createObbEdgesGeometry, []);
  // Keyed by array index, not sensor id: a sensor may carry several OBBs.
  const boxRefs = useRef<(Group | null)[]>([]);

  useImperativeHandle(
    ref,
    () => ({
      // A box's world pose is the sensor's solved device-frame pose composed
      // with the box's baked local pose — the web counterpart of the C++
      // `resolved(target_frame) * local_transform`. The box hides whenever its
      // sensor can't be placed (same null path as the gizmos and halos), so a
      // coil-referenced box vanishes without a coil.
      update(sample: GloveSample): void {
        const anchor = anchorRotation(skel, sample);
        gloveObbs.forEach(({ sensorId, obb }, i) => {
          const group = boxRefs.current[i];
          if (!group) return;
          const pose = sensorPoseOnSkeleton(skel, sample, sensorId, glove.isRight, anchor);
          group.visible = pose !== null;
          if (pose === null) return;
          const { position: pos, rotation: q } = pose;
          const wp = vAdd(pos, vTransform(obb.center, q));
          const wq = qMul(q, obb.quat);
          // Device-frame values written straight in; the parent group rebases them.
          group.position.set(wp[0], wp[1], wp[2]);
          group.quaternion.set(wq[0], wq[1], wq[2], wq[3]);
        });
      },
    }),
    [gloveObbs, glove, skel],
  );

  return (
    <>
      {gloveObbs.map(({ obb }, i) => (
        <group
          key={i}
          visible={false}
          ref={(el) => {
            boxRefs.current[i] = el;
          }}
        >
          <lineSegments
            geometry={geometry}
            frustumCulled={false}
            scale={[obb.halfExtents[0], obb.halfExtents[1], obb.halfExtents[2]]}
          >
            <lineBasicMaterial color={OBB_COLOR} />
          </lineSegments>
        </group>
      ))}
    </>
  );
}
