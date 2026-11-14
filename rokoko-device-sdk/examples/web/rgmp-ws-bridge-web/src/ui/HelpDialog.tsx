// Modal help overlay: lists keyboard shortcuts, the axis colors, and the grid
// units. Opened with "?" (see App), dismissed with Esc, a backdrop click, or
// the close button.

import { Fragment, useEffect, useRef } from "react";
import { AXIS_COLORS } from "../scene/SceneView.tsx";
import { GRID_UNITS } from "../scene/grid.ts";
import { GHOST_COLOR } from "../scene/ghost-overlay.ts";
import { OPENXR_COLOR } from "../scene/openxr-overlay.ts";
import { EMF_COLOR_BAD, EMF_COLOR_GOOD, EMF_COLOR_WARN } from "../scene/emf-overlay.ts";
import { OBB_COLOR } from "../scene/obb-overlay.ts";
import { shortcutGroups } from "./shortcuts.ts";

// The perf overlay (and its shortcut) exists only in dev builds.
const SHORTCUT_GROUPS = shortcutGroups(import.meta.env.DEV);

const AXES: { axis: string; color: string; note: string }[] = [
  { axis: "X", color: AXIS_COLORS.x, note: "left / right" },
  { axis: "Y", color: AXIS_COLORS.y, note: "up / down" },
  { axis: "Z", color: AXIS_COLORS.z, note: "forwards / backwards" },
];

const squareCm = (meters: number) => {
  const cm = Math.round(meters * 100);
  return `${cm} x ${cm}`;
};

export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // While open, swallow keystrokes at the capture phase so Esc closes the
  // dialog and the window-level app shortcuts don't fire behind it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") onClose();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="help-backdrop" onClick={onClose}>
      <div
        className="help-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts and legend"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="help-header">
          <h2>Help</h2>
          <button className="help-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="help-body">
          <section className="help-section">
            <h3>Keyboard shortcuts</h3>
            <table className="help-table">
              <tbody>
                {SHORTCUT_GROUPS.map((group) => (
                  <Fragment key={group.title}>
                    <tr className="help-group">
                      <td colSpan={2}>{group.title}</td>
                    </tr>
                    {group.items.map((s) => (
                      <tr key={`${group.title}-${s.display}`}>
                        <td>
                          <kbd>{s.display}</kbd>
                        </td>
                        <td>{s.description}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </section>

          <section className="help-section">
            <h3>Axes</h3>
            <div className="axes-legends">
              {AXES.map((a) => (
                <div key={a.axis}>
                  <span className="help-swatch" style={{ background: a.color }} />
                  <strong>{a.axis}</strong>
                </div>
              ))}
            </div>
            <p className="help-muted">
              The axis lines are anchored at <strong>(0,0,0)</strong> and point towards positive
              values. The coordinate system is right-handed.
            </p>

            <h3>Grid scale</h3>
            <p className="help-muted">
              <span className="white">{squareCm(GRID_UNITS.cell)}</span> cm cells and{" "}
              <span className="white">{squareCm(GRID_UNITS.section)}</span> cm sections, in the{" "}
              <strong style={{ color: "white" }}>XZ</strong> plane. The key in the bottom-right of
              the 3D pane draws one of each, a section being 5 × 5 cells.
            </p>

            <h3>Status bar badges</h3>
            <p className="help-muted">
              Calibration flags from the stream, per device, in the bar at the bottom: <br />{" "}
              <span
                className="diag-badge diag-on"
                style={{ display: "inline-block", margin: "4px 0" }}
              >
                heading
              </span>{" "}
              from{" "}
              <code style={{ fontSize: "0.8rem", color: "lightgray" }}>is_heading_reliable</code>
              <br />
              <span
                className="diag-badge diag-off"
                style={{ display: "inline-block", margin: "4px 0" }}
              >
                emf flip
              </span>{" "}
              from <code style={{ fontSize: "0.8rem", color: "lightgray" }}>emf_flip_decided</code>
              <br />
              They are <span style={{ color: "#d29922" }}>amber</span> while the glove is still
              initializing, <span style={{ color: "#50a340" }}>green</span> once settled. Shown only
              when the glove reports the flag.
            </p>

            <h3>Coil Pro (P)</h3>
            <p className="help-muted">
              The model appears as soon as a glove&apos;s stream reports a Coil Pro. The Coil
              button, next to XR in the top-right of the 3D pane, hides and shows it. The button is
              greyed out while no Coil Pro is present.
            </p>

            <h3>Sensor bounding boxes (O)</h3>
            <ul className="help-axes">
              <li>
                <span className="help-swatch" style={{ background: OBB_COLOR }} />
                <strong>Orange wireframe</strong>
                <span className="help-muted">the sensor&apos;s physical envelope</span>
              </li>
            </ul>
            <p className="help-muted">
              Read from the device&apos;s stream definition; hidden when the device doesn&apos;t
              report one.
            </p>

            <h3>EMF residual halos (E)</h3>
            <ul className="help-axes">
              <li>
                <span className="help-swatch" style={{ background: EMF_COLOR_GOOD }} />
                <strong>Green</strong>
                <span className="help-muted">low residual, tracking good</span>
              </li>
              <li>
                <span className="help-swatch" style={{ background: EMF_COLOR_WARN }} />
                <strong>Amber</strong>
                <span className="help-muted">mid-scale residual (&ge;13%)</span>
              </li>
              <li>
                <span className="help-swatch" style={{ background: EMF_COLOR_BAD }} />
                <strong>Red</strong>
                <span className="help-muted">residual at or beyond 20%</span>
              </li>
            </ul>
            <p className="help-muted">Hidden entirely when absent from stream.</p>

            <h3>Solver comparison (S)</h3>
            <ul className="help-axes">
              <li>
                <span className="help-swatch" style={{ background: AXIS_COLORS.z }} />
                <strong>Blue solid</strong>
                <span className="help-muted">internal solver</span>
              </li>
              <li>
                <span className="help-swatch" style={{ background: GHOST_COLOR }} />
                <strong>Amber dashes</strong>
                <span className="help-muted">external solver, drawn on top</span>
              </li>
            </ul>
            <p className="help-muted" style={{ marginBottom: 6 }}>
              <strong>Note</strong> that when the two solvers agree, the skeletons coincide exactly,
              so blue shows through the amber gaps; blue separating from amber marks a real
              difference.
            </p>
            <p className="help-muted">
              Both are solved from the same glove frame, paired by timestamp, so the readout&apos;s
              Δ is solver divergence and not stream latency.
              <br /> <em>Lag</em> is how far behind live that paired frame is. The Δ figures are the
              worst seen in the last half second.
            </p>

            <h3>OpenXR joints (X)</h3>
            <ul className="help-axes">
              <li>
                <span className="help-swatch" style={{ background: OPENXR_COLOR }} />
                <strong>Teal spheres</strong>
                <span className="help-muted">
                  the external solver&apos;s <code>joints_openxr</code> group; each sphere&apos;s
                  radius is the published joint radius
                </span>
              </li>
            </ul>
            <p className="help-muted">
              Needs the solver comparison (S) connected and the sidecar run with{" "}
              <code>--emit-openxr</code>. The joints arrive pre-converted to a Y-up frame and are
              drawn <em>without</em> the viewer&apos;s device-to-scene rotation, so landing exactly
              on the hand proves the sidecar&apos;s OpenXR frame conversion. Each triad shows the
              OpenXR joint frame: <strong style={{ color: AXIS_COLORS.z }}>+Z</strong> back along
              the bone toward the wrist, <strong style={{ color: AXIS_COLORS.y }}>+Y</strong> out
              the back of the hand or the fingernail (the thumb&apos;s rolled ~90°). While the
              joints are on screen the hand mesh is faded so they aren&apos;t buried inside the
              fingers.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
