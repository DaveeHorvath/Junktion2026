// The sidecar's OpenXR joints, drawn over the solved hand — the visual check
// for `rkk-hand-solver --emit-openxr`. The buffer plumbing is shared with any
// other sidecar joint overlay; see joint-overlay.ts.
//
// The `joints_openxr` group is *already rebased*: the sidecar converts the
// glove's NED frame (+Z down) to a Y-up `xr_base` frame with the same +90°
// about X the viewer applies to device data (DEVICE_TO_THREE_ROTATION in
// HandRig.tsx). So this overlay deliberately mounts OUTSIDE that rebasing
// group and applies no transform of its own. If — and only if — the sidecar's
// base change and per-joint orientation corrections are right, the spheres
// land exactly on the solved hand. Re-applying any conversion here could
// cancel the very bug this exists to reveal.
//
// What to look for, per joint:
//   - the sphere sits on its skeleton joint (positions pass through), sized by
//     the published `joint_radius`;
//   - the triad's +Z (blue) points back along the bone toward the wrist;
//   - the triad's +Y (green) comes out of the back of the hand / the
//     fingernail, with the thumb's rolled ~90°;
//   - the palm sphere sits mid-way along the middle metacarpal;
//   - both hands look right, not just one (the emitter maps joints by bone id
//     because the two skeletons order their nodes differently).

/** Overlay color — teal, against the app's blue and the ghost's amber. */
export const OPENXR_COLOR = "#3fd0c9";

/** Drawn after the ghost overlay, likewise depth-free, so it stays legible. */
export const OPENXR_RENDER_ORDER = 11;

/** Per-joint triad size in meters — big enough to read a finger's roll. */
export const OPENXR_AXIS_LENGTH = 0.014;
