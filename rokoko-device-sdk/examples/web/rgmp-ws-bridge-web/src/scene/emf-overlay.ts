// The EMF residual halos: per-sensor translucent spheres in the 3D view whose
// color and opacity track the relative EMF residual (see EMF_RESIDUAL_LABEL in
// solver/smartglove.ts) — an at-a-glance interference map. This module holds
// the residual → color/opacity mapping and its constants; the rendering lives
// in HandRig.tsx (updateEmfHalos).
//
// Not to be confused with the solver-comparison overlay in ghost-overlay.ts:
// that "ghost" is the sidecar's amber dashed skeleton. The halos are
// deliberately a different form (translucent volume, not lines) and render
// beneath it (see EMF_HALO_RENDER_ORDER).

import { Color } from "three";

/**
 * Residual gradient stops (percent of the expected EMF magnitude): pure
 * green at 0, pure amber at WARN, pure red at BAD. The value itself is
 * unbounded — the docs define 100% as "residual equals the expected field" —
 * so both color and opacity simply saturate at the bad threshold.
 */
export const EMF_RESIDUAL_WARN_PCT = 13;
export const EMF_RESIDUAL_BAD_PCT = 20;

/** Halo gradient endpoints — exported so the help dialog can describe them. */
export const EMF_COLOR_GOOD = "#3fb950"; // green: residual ≈ 0
export const EMF_COLOR_WARN = "#d29922"; // amber: at the warn threshold
export const EMF_COLOR_BAD = "#f85149"; // red: at or beyond the bad threshold

/**
 * Subtle but clearly visible at zero residual: real gloves idle at 1–4%, and
 * a floor much lower than this made healthy halos so faint the feature read
 * as broken. "No residual data" still differs — that hides a halo entirely.
 */
export const EMF_OPACITY_MIN = 0.18;
export const EMF_OPACITY_MAX = 0.6;

/** Halo radius in meters; comfortably wraps the 9 mm sensor gizmo cubes. */
export const EMF_HALO_RADIUS = 0.008;

/**
 * Draw order within the transparent pass, below the solver ghost
 * (GHOST_RENDER_ORDER = 10). The halos are depth-tested, so this only
 * orders them against other transparent objects — opaque geometry
 * (fingers, palm) occludes them regardless.
 */
export const EMF_HALO_RENDER_ORDER = 9;

/** Normalize a residual percentage to [0, 1], clamped at the bad threshold. */
export function emfResidualT(residualPct: number): number {
  return Math.min(Math.max(residualPct / EMF_RESIDUAL_BAD_PCT, 0), 1);
}

/** Halo opacity for a normalized residual: linear MIN → MAX. */
export function emfHaloOpacity(t: number): number {
  return EMF_OPACITY_MIN + (EMF_OPACITY_MAX - EMF_OPACITY_MIN) * t;
}

// Gradient stops as Color instances, parsed once; emfHaloColor lerps between
// them into the caller's Color so the per-frame path allocates nothing.
const COLOR_GOOD = new Color(EMF_COLOR_GOOD);
const COLOR_WARN = new Color(EMF_COLOR_WARN);
const COLOR_BAD = new Color(EMF_COLOR_BAD);

/**
 * Halo color for a residual percentage, written into `out` (preallocated by
 * the caller) and returned: GOOD → WARN over 0 to EMF_RESIDUAL_WARN_PCT,
 * WARN → BAD over EMF_RESIDUAL_WARN_PCT to EMF_RESIDUAL_BAD_PCT, saturating
 * at BAD beyond that.
 */
export function emfHaloColor(residualPct: number, out: Color): Color {
  const pct = Math.max(residualPct, 0);
  if (pct < EMF_RESIDUAL_WARN_PCT) {
    return out.lerpColors(COLOR_GOOD, COLOR_WARN, pct / EMF_RESIDUAL_WARN_PCT);
  }
  if (pct < EMF_RESIDUAL_BAD_PCT) {
    const span = EMF_RESIDUAL_BAD_PCT - EMF_RESIDUAL_WARN_PCT;
    return out.lerpColors(COLOR_WARN, COLOR_BAD, (pct - EMF_RESIDUAL_WARN_PCT) / span);
  }
  return out.copy(COLOR_BAD);
}
