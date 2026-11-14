// 3D viewport for sensor and skeleton visualization.
//
// Renders each connected glove as a solved hand (HandRig) — a skinned
// mesh, labelled sensor triads, or per-joint angle readouts riding the solved
// skeleton, switched by the Mesh/Sensors/Angles control in the pane's corner.
// Scene units are meters (a hand spans ~0.2), three.js conventions:
// right-handed, Y up, grid in the XZ plane.
//
// Two data paths feed this view. Scene *structure* (which devices, which
// sensors) comes from React state at ~15 Hz, which is plenty for
// connect/disconnect. Sensor *poses* come from `live()` — the mutable frame
// snapshot polled once per animation frame (latest-wins) and applied by
// mutating three.js objects directly, so pose updates run at display refresh
// rate while the glove streams at ~83 Hz, without React re-renders.

import { Suspense, useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Grid, Line, OrbitControls } from "@react-three/drei";
import { Box3, Sphere, Vector3, type PerspectiveCamera } from "three";
import type { DeviceView, LiveDevice } from "../protocol/rgmp.ts";
import { describeGlove } from "../solver/smartglove.ts";
import { CoilRig } from "./CoilRig.tsx";
import { GRID_UNITS } from "./grid.ts";
import { GridLegend } from "./GridLegend.tsx";
import { HandRig, type BoundsProbe, type HandDisplay, type HeadingProbe } from "./HandRig.tsx";
import { Segmented, usePersistedState, useShortcuts } from "@rkk/bridge-web-core";
import { PerfMonitor } from "../dev/PerfMonitor.tsx";
import type { UseCompare } from "../compare/use-compare.ts";
import { GHOST_COLOR } from "./ghost-overlay.ts";
import { OPENXR_COLOR } from "./openxr-overlay.ts";
import { parseObbStatics } from "./obb-overlay.ts";
import { SHORTCUTS } from "../ui/shortcuts.ts";
import { coilToggle } from "../ui/coil-toggle.ts";

interface SceneViewProps {
  live: () => ReadonlyMap<number, LiveDevice>;
  devices: DeviceView[];
  /**
   * The solver comparison, when the sidecar stream is wired up. A glove gets the
   * overlay as soon as a solved hand for its device id is streaming.
   */
  compare?: UseCompare;
  /** Some glove's stream reports a Coil Pro present. */
  coilPresent: boolean;
  /**
   * Whether the Coil Pro model is drawn: not hidden by the user, and a Coil Pro
   * present in the stream. Owned by App, so the choice survives switching to the
   * Streams layout and back. Toggled from here by the Coil button and the P
   * shortcut, both of which do nothing while no Coil Pro is present.
   */
  showCoil: boolean;
  onToggleCoil: () => void;
}

/** Spacing between glove rigs along X. */
const GLOVE_SPACING = 0.45;

/**
 * Height of the hand rigs. The solver anchors the hub at the rig origin and
 * fingers can reach ~0.12 below it.
 */
const RIG_HEIGHT = 0.15;

/**
 * Where the Coil Pro model sits: the scene origin, the coil_pro frame's
 * origin. World-anchored hand rigs render in this frame (see HandRig.tsx), so
 * the model marks the point their positions are physically relative to.
 */
const COIL_POSITION: [number, number, number] = [0, 0, 0];

/** Half-extent of the box kept in frame around the Coil Pro on reframe (A). */
const COIL_FRAME_MARGIN = 0.3;

const DISPLAYS: { mode: HandDisplay; label: string }[] = [
  { mode: "mesh", label: "Mesh" },
  { mode: "sensors", label: "Sensors" },
  { mode: "angles", label: "Angles" },
];

type CameraView = "top" | "front" | "left" | "right" | "back" | "home";

/**
 * Camera preset positions and their shortcut keys, all looking at the
 * OrbitControls target. Recentered hands (V) point their fingers toward -Z
 * (viewer on +Z), so "front" — the view facing the fingertips — is on the -Z
 * side. Keys
 * come from the shortcut registry (ui/shortcuts.ts).
 */
const CAMERA_VIEWS: Record<CameraView, { position: [number, number, number]; key: string }> = {
  // The initial Canvas camera.
  home: { position: [0, 0.55, 0.5], key: SHORTCUTS.viewHome.key },
  // Z epsilon avoids up-vector degeneracy.
  top: { position: [0, 1.0, 0.001], key: SHORTCUTS.viewTop.key },
  front: { position: [0, 0.25, -0.7], key: SHORTCUTS.viewFront.key },
  // +Z side, mirror of front.
  back: { position: [0, 0.25, 0.7], key: SHORTCUTS.viewBack.key },
  left: { position: [-0.7, 0.25, 0], key: SHORTCUTS.viewLeft.key },
  right: { position: [0.7, 0.25, 0], key: SHORTCUTS.viewRight.key },
};

const CAMERA_TARGET: [number, number, number] = [0, 0.1, 0];

/** Origin-gizmo axis colors. Exported so the help dialog can describe them. */
export const AXIS_COLORS = { x: "#ff3653", y: "#3fcf3f", z: "#4f8cff" } as const;

type Vec3 = [number, number, number];

/** Persisted camera pose, so a reload keeps the angle the user left it at. */
interface SavedCamera {
  position: Vec3;
  target: Vec3;
}

const CAMERA_KEY = "rgmp.camera";

// Read/written directly rather than through usePersistedState, which the
// display mode and heading above do use. The camera pose is produced outside
// React: it is read off the three.js camera in an imperative OrbitControls
// "end" handler and applied straight back to it, so routing it through state
// would add a re-render per drag and buy nothing — nothing renders from it.

function loadCamera(): SavedCamera | null {
  try {
    const raw = localStorage.getItem(CAMERA_KEY);
    return raw === null ? null : (JSON.parse(raw) as SavedCamera);
  } catch {
    return null;
  }
}

function saveCamera(saved: SavedCamera): void {
  try {
    localStorage.setItem(CAMERA_KEY, JSON.stringify(saved));
  } catch {
    // Best-effort: storage full or blocked.
  }
}

export function SceneView({
  live,
  devices,
  compare,
  coilPresent,
  showCoil,
  onToggleCoil,
}: SceneViewProps) {
  const [display, setDisplay] = usePersistedState<HandDisplay>("rgmp.display", "mesh");
  // Off by default: a diagnostics layer for investigating tracking quality.
  const [showEmf, setShowEmf] = usePersistedState<boolean>("rgmp.showEmf", false);
  // On by default (matching the C++ visualizer): a box is drawn for each OBB
  // static the device advertises, and nothing when it advertises none.
  const [showObb, setShowObb] = usePersistedState<boolean>("rgmp.showObb", true);
  // On by default: it only appears at all when the comparison is connected AND
  // the sidecar emits joints_openxr, which is already an opt-in twice over.
  const [showXr, setShowXr] = usePersistedState<boolean>("rgmp.showXr", true);
  const setViewRef = useRef<(view: CameraView) => void>(() => {});

  // Shared first-person heading. The hub references yaw to magnetic north, so
  // the hands' yaw in the scene varies with how the screen is turned relative
  // to north — a per-session unknown the stream can't resolve. "Recenter" (V)
  // captures the yaw that points the forearms away from the camera, shared by
  // both gloves (one magnetic reference) and persisted across reloads. See the
  // heading group in HandRig.tsx.
  // Keyed ".v2": the fixed rebasing dropped its constant 180° yaw, so a heading
  // saved by an earlier build is off by π under the new frame. Bumping the key
  // discards those stale values — one recenter (V) restores the user's forward.
  const [heading, setHeading] = usePersistedState<number>("rgmp.heading.v2", 0);
  const headingProbes = useRef(new Map<number, HeadingProbe>());
  const registerHeadingProbe = useCallback((deviceId: number, probe: HeadingProbe | null) => {
    if (probe) headingProbes.current.set(deviceId, probe);
    else headingProbes.current.delete(deviceId);
  }, []);
  const recenter = useCallback(() => {
    // Average the live forearm directions (XZ), then take the yaw that maps
    // that mean onto −Z (fingers away from the camera on +Z). Summing unit
    // vectors is a circular mean — robust if the two forearms aren't parallel.
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const probe of headingProbes.current.values()) {
      const v = probe();
      if (v === null) continue;
      const len = Math.hypot(v[0], v[1]);
      if (len < 1e-6) continue;
      sx += v[0] / len;
      sz += v[1] / len;
      n += 1;
    }
    if (n === 0) return; // nothing live to measure — leave the heading as-is
    // Yaw θ about +Y mapping the mean direction onto −Z: θ = atan2(x, −z).
    setHeading(Math.atan2(sx, -sz));
  }, [setHeading]);

  // "Frame gloves" (A): move the camera so every live hand is in view. Mostly
  // for coil-anchored gloves, which render at their physical positions and so
  // can wander out of the viewport — but it frames slot-anchored hands just as
  // well. The rigs report where they actually render (see BoundsProbe); the
  // camera move itself lives in CameraPresets, next to the preset jumps.
  const frameBoxRef = useRef<(box: Box3) => void>(() => {});
  const boundsProbes = useRef(new Map<number, BoundsProbe>());
  const registerBoundsProbe = useCallback((deviceId: number, probe: BoundsProbe | null) => {
    if (probe) boundsProbes.current.set(deviceId, probe);
    else boundsProbes.current.delete(deviceId);
  }, []);
  const reframe = useCallback(() => {
    const box = new Box3();
    for (const probe of boundsProbes.current.values()) {
      const b = probe();
      if (b !== null) box.union(b);
    }
    // Nothing live to frame: fall back to the home preset, the initial view of
    // the origin.
    if (box.isEmpty()) {
      setViewRef.current("home");
      return;
    }
    // Keep the Coil Pro in frame too: it marks the coil_pro origin that
    // anchored hands are positioned against, so a frame without it says
    // nothing about where the hands are. The margin comfortably covers the
    // model (~21 cm across).
    box.union(
      new Box3().setFromCenterAndSize(
        new Vector3(...COIL_POSITION),
        new Vector3().setScalar(2 * COIL_FRAME_MARGIN),
      ),
    );
    frameBoxRef.current(box);
  }, []);

  useShortcuts({
    // Cycle the display modes in control order; findIndex's -1 on an unknown
    // persisted value lands back on the first mode.
    [SHORTCUTS.cycleDisplay.key]: () =>
      setDisplay(
        (d) => DISPLAYS[(DISPLAYS.findIndex((o) => o.mode === d) + 1) % DISPLAYS.length].mode,
      ),
    [SHORTCUTS.recenter.key]: recenter,
    [SHORTCUTS.toggleCoil.key]: onToggleCoil,
    [SHORTCUTS.toggleEmf.key]: () => setShowEmf((v) => !v),
    [SHORTCUTS.toggleObb.key]: () => setShowObb((v) => !v),
    [SHORTCUTS.toggleXr.key]: () => setShowXr((v) => !v),
    [SHORTCUTS.reframe.key]: reframe,
    ...Object.fromEntries(
      (Object.keys(CAMERA_VIEWS) as CameraView[]).map((view) => [
        CAMERA_VIEWS[view].key,
        () => setViewRef.current(view),
      ]),
    ),
  });

  const gloves = useMemo(
    () =>
      devices
        .map((d) => describeGlove(d.definition))
        .filter((g) => g !== null)
        // Lay out by handedness, not device id, so left sits left and right
        // sits right regardless of which glove connected first.
        .sort((a, b) => Number(a.isRight) - Number(b.isRight)),
    [devices],
  );

  // Baked sensor-envelope boxes per device. `devices` only changes on
  // definition churn, so the parse runs once per definition, never per frame.
  const obbsByDevice = useMemo(
    () => new Map(devices.map((d) => [d.definition.device_id, parseObbStatics(d.definition)])),
    [devices],
  );

  // One readout element per compared hand, addressed by device id. Held as ref
  // objects rather than state because the rigs write to them imperatively once
  // per animation frame, exactly as they do the rest of the live pose.
  const readoutRefs = useRef(new Map<number, RefObject<HTMLDivElement | null>>());
  const compareReadoutRef = (deviceId: number): RefObject<HTMLDivElement | null> => {
    let ref = readoutRefs.current.get(deviceId);
    if (ref === undefined) {
      ref = { current: null };
      readoutRefs.current.set(deviceId, ref);
    }
    return ref;
  };

  // A glove is compared once the sidecar announces a solved hand for its device
  // id — solved hands reuse the glove's id, which is what correlates them.
  const compared = gloves.filter((g) => compare?.solved.has(g.deviceId));

  const coil = coilToggle(coilPresent, showCoil);

  return (
    <div className="scene-pane">
      {/* Camera roughly at the user's eye position, looking down at their hands. */}
      <Canvas camera={{ position: [0, 0.55, 0.5], fov: 45, near: 0.01, far: 50 }}>
        <color attach="background" args={["#0f1115"]} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[1, 2, 1.5]} intensity={1.4} />

        <Suspense fallback={null}>
          {gloves.map((glove, i) => {
            const x = (i - (gloves.length - 1) / 2) * GLOVE_SPACING;
            const ghost = compare?.solved.get(glove.deviceId);
            return (
              <HandRig
                key={glove.deviceId}
                side={glove.isRight ? "right" : "left"}
                position={[x, RIG_HEIGHT, 0]}
                display={display}
                showEmf={showEmf}
                showObb={showObb}
                showXr={showXr}
                obbs={obbsByDevice.get(glove.deviceId)}
                glove={glove}
                live={live}
                headingOffset={heading}
                registerHeadingProbe={registerHeadingProbe}
                registerBoundsProbe={registerBoundsProbe}
                ghost={ghost}
                // Only in comparison mode: without a ghost the rig keeps its
                // ordinary latest-wins solve.
                compareFrame={ghost && compare ? () => compare.frameFor(glove.deviceId) : undefined}
                compareReadout={ghost ? compareReadoutRef(glove.deviceId) : undefined}
              />
            );
          })}
          {showCoil && <CoilRig position={COIL_POSITION} />}
        </Suspense>

        <Grid
          cellSize={GRID_UNITS.cell}
          cellThickness={1}
          sectionSize={GRID_UNITS.section}
          sectionThickness={1.5}
          cellColor="#4d5567"
          sectionColor="#5a6478"
          fadeDistance={4}
          infiniteGrid
        />
        <Axes />
        <OrbitControls makeDefault target={CAMERA_TARGET} />
        <CameraPresets apply={setViewRef} frameBox={frameBoxRef} />
      </Canvas>
      <div className="scene-corner">
        {compared.length > 0 && (
          <div className="compare-readout">
            <div className="compare-legend">
              rkk-hand-solver
              <span className="compare-swatch" style={{ background: GHOST_COLOR }} />
            </div>
            {showXr && compared.some((g) => compare?.solved.get(g.deviceId)?.openxr) && (
              <div className="compare-legend">
                OpenXR joints
                <span className="compare-swatch" style={{ background: OPENXR_COLOR }} />
              </div>
            )}
            {compared.map((glove) => (
              <div key={glove.deviceId} ref={compareReadoutRef(glove.deviceId)} />
            ))}
          </div>
        )}
        <GridLegend />
      </div>
      {import.meta.env.DEV && <PerfMonitor />}
      <div className="scene-controls">
        <button
          className="emf-toggle"
          title="Show EMF residual halos (E)"
          aria-pressed={showEmf}
          onClick={() => setShowEmf((v) => !v)}
        >
          EMF
        </button>
        <button
          className="obb-toggle"
          title="Show sensor bounding boxes (O)"
          aria-pressed={showObb}
          onClick={() => setShowObb((v) => !v)}
        >
          OBB
        </button>
        <button
          className="xr-toggle"
          title="Show OpenXR joints from the external solver (X)"
          aria-pressed={showXr}
          onClick={() => setShowXr((v) => !v)}
        >
          XR
        </button>
        <button
          className="coil-toggle"
          title={coil.title}
          aria-pressed={showCoil}
          disabled={coil.disabled}
          onClick={onToggleCoil}
        >
          Coil
        </button>
        <Segmented
          ariaLabel="Display mode"
          value={display}
          onChange={setDisplay}
          options={DISPLAYS.map(({ mode, label }) => ({
            value: mode,
            label,
            title: `${label} (M)`,
          }))}
        />
      </div>
    </div>
  );
}

type OrbitControlsLike = {
  target?: Vector3;
  update?: () => void;
  enableDamping?: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
} | null;

/**
 * Bridges keyboard shortcuts (outside the Canvas) to the camera (inside it):
 * publishes an imperative "jump to preset view" function through `apply` and a
 * "fit this box in view" move through `frameBox`, and persists the camera pose
 * so a reload restores the angle the user left it at.
 */
function CameraPresets({
  apply,
  frameBox,
}: {
  apply: RefObject<(view: CameraView) => void>;
  frameBox: RefObject<(box: Box3) => void>;
}) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls);
  useEffect(() => {
    // Flush residual drag momentum first: with damping off, one update()
    // applies and zeroes the leftover delta, which would otherwise keep
    // rotating the camera away from the jump for the next second or so.
    const flushDamping = (c: OrbitControlsLike) => {
      if (c?.enableDamping) {
        c.enableDamping = false;
        c.update?.();
        c.enableDamping = true;
      }
    };
    const persist = () => {
      const t = (controls as OrbitControlsLike)?.target;
      saveCamera({
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: t ? [t.x, t.y, t.z] : CAMERA_TARGET,
      });
    };

    apply.current = (view) => {
      const c = controls as OrbitControlsLike;
      flushDamping(c);
      camera.position.set(...CAMERA_VIEWS[view].position);
      // OrbitControls must agree on the target, or the next drag snaps back.
      c?.target?.set(...CAMERA_TARGET);
      c?.update?.();
      persist();
    };

    frameBox.current = (box) => {
      const c = controls as OrbitControlsLike;
      flushDamping(c);
      const sphere = box.getBoundingSphere(new Sphere());
      // Margin so hands don't touch the viewport edge; the floor keeps a
      // single hand from filling the whole screen.
      const radius = Math.max(sphere.radius * 1.25, 0.15);
      // Back off along the current view direction far enough that the
      // bounding sphere fits the tighter of the two view angles.
      const pc = camera as PerspectiveCamera;
      const vFov = (pc.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * pc.aspect);
      const distance = radius / Math.sin(Math.min(vFov, hFov) / 2);
      const direction = camera.getWorldDirection(new Vector3());
      camera.position.copy(sphere.center).addScaledVector(direction, -distance);
      c?.target?.copy(sphere.center);
      c?.update?.();
      persist();
    };
  }, [camera, controls, apply, frameBox]);

  // Restore the saved pose once controls exist, and save it whenever the user
  // finishes an orbit/zoom/pan ("end" fires on release, so we don't thrash
  // storage mid-drag).
  useEffect(() => {
    const c = controls as OrbitControlsLike;
    if (!c) return;
    const saved = loadCamera();
    if (saved) {
      camera.position.set(...saved.position);
      c.target?.set(...saved.target);
      c.update?.();
    }
    const onEnd = () => {
      const t = c.target;
      saveCamera({
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: t ? [t.x, t.y, t.z] : CAMERA_TARGET,
      });
    };
    c.addEventListener?.("end", onEnd);
    return () => c.removeEventListener?.("end", onEnd);
  }, [camera, controls]);

  return null;
}

/**
 * Origin axes drawn as thick, anti-aliased lines. The built-in axesHelper
 * renders 1px GL lines (WebGL ignores their width), which shimmer at grazing
 * angles — worst on the dark-blue Z. X red, Y green, Z blue, as usual; the
 * blue is brightened a touch to read on the dark background.
 */
function Axes({ length = 0.15, width = 2 }: { length?: number; width?: number }) {
  return (
    <>
      <Line
        points={[
          [0, 0, 0],
          [length, 0, 0],
        ]}
        color={AXIS_COLORS.x}
        lineWidth={width}
      />
      <Line
        points={[
          [0, 0, 0],
          [0, length, 0],
        ]}
        color={AXIS_COLORS.y}
        lineWidth={width}
      />
      <Line
        points={[
          [0, 0, 0],
          [0, 0, length],
        ]}
        color={AXIS_COLORS.z}
        lineWidth={width}
      />
    </>
  );
}
