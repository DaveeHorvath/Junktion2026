// The "angles" display mode: per-joint readouts of the solver's extracted
// local euler angles (degrees, ZXY; flexion is x), riding the solved
// skeleton.
//
// Driven imperatively: HandRig calls `update` from its useFrame after the
// solve, since the labels read the freshly solved local rotations.

import { useMemo, useRef, useImperativeHandle, type Ref } from "react";
import { Billboard, Text } from "@react-three/drei";
import type { Group } from "three";
import { DRIVEN_BONES } from "../solver/finger-poser.ts";
import { quatToEuler } from "../solver/math.ts";
import type { HandSkeleton } from "../solver/hand-skeleton.ts";
import { COLOR_MUTED, formatAngles } from "./sensor-placement.ts";

/** The slice of a troika Text instance the per-frame label updates touch. */
interface AngleLabel {
  text: string;
  sync(): void;
}

export interface AngleLabelsHandle {
  /** Keep each label at its joint and refresh the readout. */
  update(): void;
}

export function AngleLabels({
  ref,
  skel,
  jointPositions,
}: {
  ref: Ref<AngleLabelsHandle>;
  /** The rig's skeleton, mutated in place by the per-frame solve. */
  skel: HandSkeleton;
  /** The rig's rest-pose joint positions, for the initial render. */
  jointPositions: [number, number, number][];
}) {
  // Joints whose local rotation the finger solver actually writes — each
  // finger's aimed parent, the sensor-driven bone, and the distal joint that
  // takes the residual curl (see solveFingers). restText is the label before
  // the first update.
  const angleJoints = useMemo(
    () =>
      DRIVEN_BONES.flatMap((id) => {
        const driven = skel.sidedBone(id);
        return [driven.parent!, driven, driven.children[0]].map((node) => ({
          node,
          index: skel.nodes.indexOf(node),
          restText: formatAngles(quatToEuler(node.localRotation)),
        }));
      }),
    [skel],
  );

  const groupRefs = useRef<(Group | null)[]>([]);
  const textRefs = useRef<(AngleLabel | null)[]>([]);

  useImperativeHandle(
    ref,
    () => ({
      // Text mutation makes troika re-shape the glyphs, so only rewrite when
      // the rounded string actually changed.
      update(): void {
        angleJoints.forEach(({ node }, i) => {
          const group = groupRefs.current[i];
          if (group) group.position.set(node.position[0], node.position[1], node.position[2]);
          const label = textRefs.current[i];
          if (!label) return;
          const text = formatAngles(quatToEuler(node.localRotation));
          if (label.text !== text) {
            label.text = text;
            label.sync();
          }
        });
      },
    }),
    [angleJoints],
  );

  return (
    <>
      {angleJoints.map(({ index, restText }, i) => (
        <group
          key={i}
          position={jointPositions[index]}
          ref={(el) => {
            groupRefs.current[i] = el;
          }}
        >
          {/* restText is stable across re-renders, so the reconciler never
              claws back the per-frame imperative text updates. */}
          <Billboard position={[0, -0.009, 0]}>
            <Text
              fontSize={0.005}
              color={COLOR_MUTED}
              ref={(el) => {
                textRefs.current[i] = el as AngleLabel | null;
              }}
            >
              {restText}
            </Text>
          </Billboard>
        </group>
      ))}
    </>
  );
}
