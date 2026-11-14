// The Coil Pro base station in the 3D scene.
//
// The model sits at the scene origin — the coil_pro frame's origin, the frame
// world-anchored hand rigs render in (see HandRig.tsx) — so anchored gloves
// appear at their physical positions relative to it.
//
// It is mounted only while the user has not hidden it and a connected glove
// reports a Coil Pro in its stream (bit 9 of the world-arm sensor's
// STATUS_FLAGS, see sampleCoilPresence), so it has no presence handling of its
// own. App.tsx owns that rule; see also ui/coil-toggle.ts.

import { useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import { Mesh, MeshStandardMaterial } from "three";

// The glb bakes its centimeter→meter scale into the node transform, so unlike
// newton.glb it mounts at scale 1 (the device is ~21 cm across, base at y=0).
export const COIL_PRO_GLB_URL = "/CoilPro.glb";
useGLTF.preload(COIL_PRO_GLB_URL);

export function CoilRig({ position }: { position: [number, number, number] }) {
  const gltf = useGLTF(COIL_PRO_GLB_URL);

  // Clone the cached scene: useGLTF shares the parsed glb, so moving the
  // original's meshes would leak into every other consumer.
  const scene = useMemo(() => {
    const clone = gltf.scene.clone(true);
    clone.traverse((o) => {
      if (!(o instanceof Mesh) || !(o.material instanceof MeshStandardMaterial)) return;
      // The actual world position reported by the Coil pro is relative to its center, not its base.
      // The glTF model has its origin at the base, so we compensate by translating the coil down 11 cm.
      // TODO: let the user input a Coil height in the UI - this would allow the ground plane to be
      // the real world floor.
      o.translateY(-11);
    });
    return clone;
  }, [gltf]);

  return (
    <group position={position}>
      <primitive object={scene} />
    </group>
  );
}
