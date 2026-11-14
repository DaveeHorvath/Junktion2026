// The RGMP bridge viewer shell: connection bar, view-mode switching, the two
// panes, and the bottom status bar. RGMP is push-only, so this is a viewer,
// not a console — connect to the bridge and watch the live stream.
//
// The 3D pane is SceneView; the live-data pane is StreamPane. The status bar
// (StatusBar) stays visible in every view mode.
//
// A second, optional connection sits behind the "Compare" toggle: the
// `rkk-hand-solver` sidecar, which solves the same gloves in Rust and re-emits
// the result as RGMP. Connecting it overlays its skeleton on this app's own and
// reports how far apart they are — see compare/pose-ring.ts.
//
// The sidecar speaks TCP, so it needs its own bridge in front of it on a second
// port — hence a separate URL here rather than a checkbox. Off by default, and
// nothing else depends on it; the viewer needs only the one stream.

import { useState } from "react";
import {
  ConnControls,
  TopBar,
  Segmented,
  usePersistedState,
  useShortcuts,
} from "@rkk/bridge-web-core";
import { useRgmp } from "./protocol/rgmp.ts";
import { useCompare } from "./compare/use-compare.ts";
import { sampleCoilPresence } from "./solver/smartglove.ts";
import { SceneView } from "./scene/SceneView.tsx";
import { StreamPane } from "./ui/StreamPane.tsx";
import { StatusBar } from "./ui/StatusBar.tsx";
import { HelpDialog } from "./ui/HelpDialog.tsx";
import { SHORTCUTS } from "./ui/shortcuts.ts";

const DEFAULT_URL = "ws://127.0.0.1:8138";

/** The bridge sitting in front of the sidecar's RGMP port. */
const DEFAULT_SOLVER_URL = "ws://127.0.0.1:8140";

/** Which panes are visible: both, streams only, or 3D only. */
type ViewMode = "both" | "streams" | "3d";

const VIEW_MODES: { mode: ViewMode; label: string; key: string }[] = [
  { mode: "streams", label: "Streams", key: SHORTCUTS.layoutStreams.key },
  { mode: "both", label: "Both", key: SHORTCUTS.layoutBoth.key },
  { mode: "3d", label: "3D", key: SHORTCUTS.layout3d.key },
];

export function App() {
  const compare = useCompare();
  // The comparison needs every glove frame, not just the newest: it pairs the
  // two solvers by timestamp. Hence the tap.
  const rgmp = useRgmp({ onFrame: compare.captureGlove, onReset: compare.resetGlove });
  const [url, setUrl] = usePersistedState("rgmp.url", DEFAULT_URL);
  const [solverUrl, setSolverUrl] = usePersistedState("rgmp.solverUrl", DEFAULT_SOLVER_URL);
  const [compareOpen, setCompareOpen] = usePersistedState("rgmp.compareOpen", false);
  const [viewMode, setViewMode] = usePersistedState<ViewMode>("rgmp.viewMode", "both");
  // The Coil Pro model is on as soon as a Coil Pro is discovered, and stays on
  // until the user hides it. The choice is not persisted: every session starts
  // with it on. It is drawn, and the toggle works, only while some glove's stream
  // reports a Coil Pro (any one is enough: a single Coil Pro serves both hands).
  // The choice itself survives a Coil Pro dropping out, so a model the user hid
  // stays hidden when the Coil Pro returns.
  //
  // Owned here rather than by SceneView (whose Coil button and P shortcut toggle
  // it) so the choice survives switching to the Streams layout, which unmounts
  // the 3D pane, and back.
  const [coilWanted, setCoilWanted] = useState(true);
  const coilPresent = rgmp.devices.some((d) => d.groups.some((g) => sampleCoilPresence(g.streams)));
  const showCoil = coilPresent && coilWanted;
  const toggleCoil = () => {
    if (coilPresent) setCoilWanted((v) => !v);
  };
  const [helpOpen, setHelpOpen] = useState(false);

  const busy = rgmp.status === "connected" || rgmp.status === "connecting";
  const compareBusy = compare.status === "connected" || compare.status === "connecting";

  /** Toggle the sidecar connection, revealing its row if it was hidden. */
  const toggleCompare = () => {
    setCompareOpen(true);
    if (compareBusy) compare.disconnect();
    else compare.connect(solverUrl);
  };

  /**
   * Show or hide the compare row. Hiding also disconnects the sidecar: a live
   * comparison behind a hidden row would keep drawing the overlay with no
   * visible control that explains it.
   */
  const setCompareEnabled = (open: boolean) => {
    setCompareOpen(open);
    if (!open) compare.disconnect();
  };

  /**
   * The master disconnect takes the comparison down with it and turns Compare
   * off — the sidecar is solving this connection's gloves, so outliving it only
   * means the next connect silently starts comparing again.
   */
  const disconnectAll = () => {
    rgmp.disconnect();
    setCompareEnabled(false);
  };

  useShortcuts({
    ...Object.fromEntries(VIEW_MODES.map(({ mode, key }) => [key, () => setViewMode(mode)])),
    [SHORTCUTS.connect.key]: () => (busy ? disconnectAll() : rgmp.connect(url)),
    [SHORTCUTS.compare.key]: toggleCompare,
    [SHORTCUTS.help.key]: () => setHelpOpen(true),
  });

  return (
    <div className="app">
      <TopBar
        title="RGMP Viewer"
        url={url}
        onUrlChange={setUrl}
        status={rgmp.status}
        busy={busy}
        onConnect={() => rgmp.connect(url)}
        onDisconnect={disconnectAll}
        error={rgmp.error}
        connectTitle="Connect (C)"
        disconnectTitle="Disconnect (C)"
      >
        <Segmented
          ariaLabel="View mode"
          value={viewMode}
          onChange={setViewMode}
          options={VIEW_MODES.map(({ mode, label, key }) => ({
            value: mode,
            label,
            title: `${label} (${key})`,
          }))}
        />
        <button
          className="compare-toggle"
          title="Compare against rkk-hand-solver (S)"
          aria-pressed={compareOpen}
          onClick={() => setCompareEnabled(!compareOpen)}
        >
          Compare
        </button>
        <button
          className="help-btn"
          title="Help (?)"
          aria-label="Help"
          onClick={() => setHelpOpen(true)}
        >
          ?
        </button>
      </TopBar>

      {compareOpen && (
        <div className="compare-bar">
          <label htmlFor="solver-url">Solver</label>
          <ConnControls
            inputId="solver-url"
            url={solverUrl}
            onUrlChange={setSolverUrl}
            status={compare.status}
            busy={compareBusy}
            onConnect={() => compare.connect(solverUrl)}
            onDisconnect={compare.disconnect}
            connectTitle="Connect (S)"
            disconnectTitle="Disconnect (S)"
          />
          <span className="compare-hint">
            overlays <code>rkk-hand-solver</code>&apos;s hands on this app&apos;s, matched by
            timestamp
          </span>
        </div>
      )}
      {compareOpen && compare.error && <div className="banner error">{compare.error}</div>}

      <main className="content">
        {viewMode !== "streams" && (
          <SceneView
            live={rgmp.live}
            devices={rgmp.devices}
            compare={compare}
            coilPresent={coilPresent}
            showCoil={showCoil}
            onToggleCoil={toggleCoil}
          />
        )}
        {viewMode !== "3d" && <StreamPane devices={rgmp.devices} status={rgmp.status} />}
      </main>

      <StatusBar devices={rgmp.devices} />

      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
