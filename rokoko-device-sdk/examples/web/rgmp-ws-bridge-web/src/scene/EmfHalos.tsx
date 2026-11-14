// EMF residual halos: translucent per-sensor spheres whose color and opacity
// track the latest residual (see emf-overlay.ts), positioned on the solved
// skeleton. Independent of the display mode. Unlit so lighting can't shift
// the data color. Depth-TESTED (unlike the ghost overlay): fingers occlude
// orbs behind them and each orb reads as a dome bulging from its finger — at
// the cost that a bad sensor can hide behind the hand until the camera
// orbits. depthWrite stays off so overlapping orbs blend rather than punch
// holes in each other.
//
// Driven imperatively: HandRig calls `update` from its useFrame after the
// solve, since halo placement reads the freshly solved skeleton.

import { useMemo, useRef, useImperativeHandle, type Ref } from "react";
import type { Mesh, MeshBasicMaterial } from "three";
import type { DecodedStream, LiveDevice } from "../protocol/rgmp.ts";
import {
  createEmfResidualScratch,
  sampleEmfResidualsInto,
  type GloveDescriptor,
  type GloveSample,
} from "../solver/smartglove.ts";
import type { HandSkeleton } from "../solver/hand-skeleton.ts";
import {
  EMF_HALO_RADIUS,
  EMF_HALO_RENDER_ORDER,
  emfHaloColor,
  emfHaloOpacity,
  emfResidualT,
} from "./emf-overlay.ts";
import { anchorRotation, sensorPoseOnSkeleton } from "./sensor-placement.ts";

export interface EmfHalosHandle {
  /** Recolor and re-place the halos from the latest residuals. */
  update(sample: GloveSample): void;
}

export function EmfHalos({
  ref,
  glove,
  live,
  skel,
}: {
  ref: Ref<EmfHalosHandle>;
  glove: GloveDescriptor;
  live: () => ReadonlyMap<number, LiveDevice>;
  /** The rig's skeleton, mutated in place by the per-frame solve. */
  skel: HandSkeleton;
}) {
  const haloRefs = useRef<(Mesh | null)[]>([]);
  const matRefs = useRef<(MeshBasicMaterial | null)[]>([]);
  // Per-instance scratch so the per-frame residual sampling allocates nothing;
  // groupsScratch gathers the residual-carrying groups' streams the same way.
  const scratch = useMemo(createEmfResidualScratch, []);
  const groupsScratch = useRef<(readonly DecodedStream[])[]>([]);

  useImperativeHandle(
    ref,
    () => ({
      // Every failure mode hides rather than alarms — no residual groups, no
      // frames for them yet, or a sensor without a value this frame. Residual
      // groups can stream slower than the motion group; latest-wins means a
      // stalled residual stream leaves a stale-colored halo, consistent with
      // the rest of the viewer. Residuals span groups on real gloves, hence
      // the gather loop.
      update(sample: GloveSample): void {
        const device = live().get(glove.deviceId);
        const groups = groupsScratch.current;
        groups.length = 0;
        for (const groupId of glove.emfGroupIds) {
          const streams = device?.groups.get(groupId)?.streams;
          if (streams) groups.push(streams);
        }
        const residuals = groups.length > 0 ? sampleEmfResidualsInto(groups, scratch) : null;
        const anchor = anchorRotation(skel, sample);

        for (const id of glove.emfSensorIds) {
          const halo = haloRefs.current[id];
          if (!halo) continue;
          const residual = residuals?.[id] ?? null;
          // The world-arm residual describes Coil Pro tracking and its halo
          // sits at the streamed coil-frame position, both meaningless without
          // a coil: sensorPoseOnSkeleton withholds that pose, which hides it.
          const pose =
            residual === null
              ? null
              : sensorPoseOnSkeleton(skel, sample, id, glove.isRight, anchor);
          halo.visible = residual !== null && pose !== null;
          if (residual === null || pose === null) continue;
          halo.position.set(pose.position[0], pose.position[1], pose.position[2]);
          const mat = matRefs.current[id];
          if (mat) {
            emfHaloColor(residual, mat.color);
            mat.opacity = emfHaloOpacity(emfResidualT(residual));
          }
        }
      },
    }),
    [glove, live, skel, scratch],
  );

  return (
    <>
      {glove.emfSensorIds.map((id) => (
        <mesh
          key={id}
          visible={false}
          frustumCulled={false}
          renderOrder={EMF_HALO_RENDER_ORDER}
          ref={(el) => {
            haloRefs.current[id] = el;
          }}
        >
          <sphereGeometry args={[EMF_HALO_RADIUS, 16, 12]} />
          <meshBasicMaterial
            transparent
            depthWrite={false}
            ref={(el) => {
              matRefs.current[id] = el;
            }}
          />
        </mesh>
      ))}
    </>
  );
}
