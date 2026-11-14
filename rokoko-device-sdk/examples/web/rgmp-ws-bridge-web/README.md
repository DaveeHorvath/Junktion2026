# rgmp-ws-bridge-web

A browser **viewer** for the live RGMP v2 data stream, served through the **RGMP
bridge** — a local WebSocket bridge. Browsers can't read the RGMP v2 TCP stream
directly, so this app connects to the bridge over WebSocket and the bridge
relays the device's stream. The bridge is the `rkk-ws-bridge` binary bundled in
the SDK's `bin/` directory; run it alongside this app.

RGMP v2 is push-only: the device streams to you. So this is a viewer, not a
console — connect and watch. Each connected device renders as a card; within
it, each group shows its measured update rate and the latest decoded value of
every stream, updating in place rather than as a scrolling log.

Connect Smartgloves II and the 3D pane goes further: it solves the sensor
stream into a posed hand and renders it as a skinned mesh, labelled sensor
triads, or per-joint angle readouts. Hands appear as their gloves are
discovered. The scene also shows a **Coil Pro** base station at the origin once
the stream reports one tracking, which you can hide. When one is tracking, the
solved hands are world-anchored to it and render at their physical positions
instead of in fixed viewing slots.

Built with Vite + React + TypeScript. Part of the `web/` pnpm workspace; the
WebSocket lifecycle, the connection bar, the segmented control, and the shared
stylesheet come from the [`@rkk/bridge-web-core`](../bridge-web-core) package.

## Layout

The app is three layers, each depending only on the one above it, and each
readable on its own. **If you are here to learn the protocol, `src/protocol/` is
all you need** — the solver and the 3D scene are a Smartgloves-specific extra
built on top of it.

### `src/protocol/` — the wire (no React, no three.js)

- `rgmp-layout.ts` — stream-definition parsing and data-frame decoding: the
  `data_type` grammar, per-group `StreamLayout`, and little-endian value
  unpacking. Equivalent to the Python reference client's decoding.
- `rgmp-client.ts` — framework-agnostic RGMP client: the hybrid wire contract
  (JSON text envelopes + binary data frames), decoding each data frame against
  the device's layout. Composes `SocketConnection` from `@rkk/bridge-web-core`
  for the connection lifecycle.
- `rgmp.ts` — React adapter (`useRgmp`). Holds a mutable snapshot in a ref and
  publishes it to React state on a ~15 Hz timer, so 60-120 Hz streaming doesn't
  re-render per frame; also computes each group's measured rate. Consumers that
  need every frame poll `live()` on their own clock instead.

If you are writing your own client, this directory is the part worth copying.

### `src/solver/` — Smartgloves sensors to a posed hand (pure, framework-free)

A TypeScript port of Rokoko's reference solver, kept numerically identical to
it. Read in this order:

- `smartglove.ts` — stream interpretation: recognize a glove from its
  definition, map `(target_frame, reference_frame)` to a sensor id, and read
  each frame's orientations, positions, and status flags.
- `math.ts` — quaternion/vector primitives and, importantly, **the frame
  conventions the rest of the solver assumes**. Start here if the rendered hand
  ever looks mirrored or rotated.
- `transform-node.ts` — the bone transform hierarchy: world/local duality and
  the forward-kinematics kernels, written allocation-free for the hot path.
- `hand-skeleton.ts` — the forearm-and-below skeleton and its rest pose, with
  the T-pose joint data in the generated `hand-skeleton-data.ts`.
- `finger-poser.ts` — `solveFingers`: one frame of sensor state in, a posed
  skeleton out. The core of the port.

### `src/scene/` — rendering (three.js via @react-three/fiber)

- `SceneView.tsx` — the viewport: camera presets, grid and axes, and the
  per-device rigs. Owns the shared "recenter" heading (see `R` below).
- `grid.ts`, `GridLegend.tsx` — the grid's tile sizes, and the 2D key in the
  bottom-right of the pane that draws one small tile and one large tile (5 × 5 small
  ones) with their sizes.
- `HandRig.tsx` — one hand: runs the solver once per animation frame and drives
  the mesh, the stick overlay, the sensor gizmos, or the angle readouts. Also
  where the single device→three.js frame rebasing lives, and where a hand
  switches per frame between its fixed viewing slot (hub-anchored) and the
  coil_pro frame at the scene origin (world-anchored, when a Coil Pro is
  tracking).
- `CoilRig.tsx` — the Coil Pro base station model (`public/CoilPro.glb`),
  placed at the scene origin to mark the coil_pro frame world-anchored hands
  are positioned against. It appears as soon as a connected glove reports a Coil
  Pro in its stream, and the **Coil** toggle (`P`, or the button next to XR)
  hides and shows it; the toggle is greyed out while no Coil Pro is present.
- `newton-mesh.ts` — cuts the skinned hand branch out of `public/newton.glb` and
  writes solved bone transforms back into it. That `.glb` is required; the 3D
  pane has nothing to skin without it.
- `ghost-overlay.ts` — the second skeleton drawn by the solver comparison below.

### `src/compare/` — the solver comparison (optional, off by default)

The **Compare** toggle opens a second RGMP connection to `rkk-hand-solver` —
the hand-solving binary in the SDK's `bin/` directory, which solves the same
gloves independently and re-emits the result as RGMP v2. Its skeleton is
overlaid on this app's own and the two are measured against each other, frame
by frame. Handy as a second opinion when a solved hand looks wrong and you need
to know whether it is the data or the solve.

It is off by default and nothing else in the app depends on it. See
[Comparing solvers](#comparing-solvers) to run it. Beyond the feature itself,
the code is worth reading for one idea:

- `pose-sync.ts` — **its header explains why the two streams are paired by
  timestamp** rather than both read live. Comparing each stream's newest frame
  measures the second stream's latency, not the difference between the solvers.
  The same trap applies to anything you diff against a live feed.
- `use-compare.ts` — the React side: the second connection and the two rings.

### `src/ui/` and the entry points

- `src/main.tsx`, `src/App.tsx` — the entry point and the shell: connection bar,
  view-mode switching, the two panes.
- `src/ui/StreamPane.tsx` — the live-data pane, one card per device.
- `src/ui/HelpDialog.tsx` — the help overlay (`?`).
- `src/dev/PerfMonitor.tsx` — a main-thread health overlay for diagnosing
  stutter (`D`). Present under `pnpm dev` only; `pnpm build` strips it.

## Running

```sh
pnpm install
pnpm dev        # http://localhost:5181
```

Start the bundled bridge (the `rkk-ws-bridge` binary in the SDK's `bin/`
directory) alongside this app, after the Rokoko SDK Driver is streaming RGMP v2:

```sh
rkk-ws-bridge --rgmp-only
```

Then open the app, confirm the bridge URL (`ws://127.0.0.1:8138`), and Connect.
The address you enter is remembered across reloads.

Also available:

```sh
pnpm typecheck  # type-check without emitting
pnpm build      # type-check + production bundle
pnpm preview    # serve the built bundle
```

With nothing connected, the 3D pane shows only the grid and origin axes. Hands
are drawn as their gloves are discovered, and the Coil Pro model appears once
a stream reports a Coil Pro.

### Comparing solvers

`rkk-hand-solver` (also in the SDK's `bin/`) solves the same glove stream and
re-emits it, so you can overlay its result on this app's and see where the two
disagree. It reads the driver's RGMP v2 port and serves its own on `:12277`.

It speaks TCP, though, and browsers cannot, so it needs a **second** bridge in
front of it — one bridge instance fronts exactly one endpoint. Three processes
alongside the driver:

```sh
rkk-ws-bridge --rgmp-only                      # the driver's stream  -> :8138
rkk-hand-solver --no-driver --emit world       # solved hands         -> :12277
rkk-ws-bridge --rgmp-only \
  --rgmp-addr 127.0.0.1:12277 --rgmp-listen 127.0.0.1:8140
```

`--emit world` matters: it sends every joint's world pose, so the overlay can be
drawn directly instead of running forward kinematics against a rest pose.
`--no-driver` stops the solver launching a second driver that would fight the
first over the USB device.

Then press **Compare** (or `S`), confirm `ws://127.0.0.1:8140`, and connect. The
amber dashes are the sidecar's skeleton over this app's blue one; where they
agree the two are exactly coincident, so blue shows through the gaps. The corner
readout gives the largest per-joint difference and how far behind live the
compared frame is.

## Keyboard shortcuts

Press `?` (or the `?` button in the top bar) for an in-app reference; `Esc`
closes it. Shortcuts are ignored while a text field is focused.

| Key                         | Action                                        |
| --------------------------- | --------------------------------------------- |
| `?` / `Esc`                 | Open / close the help dialog                  |
| `C`                         | Connect / disconnect                          |
| `S`                         | Connect / disconnect the solver comparison    |
| `1` / `2` / `3`             | Streams / Both / 3D layout                    |
| `M`                         | Cycle mesh / sensors / angles (3D pane)       |
| `P`                         | Show / hide the Coil Pro model (if present)   |
| `E`                         | Show / hide EMF residual halos                |
| `O`                         | Show / hide sensor bounding boxes (OBBs)      |
| `X`                         | Show / hide OpenXR joints (solver compare)    |
| `V`                         | Recenter heading (3D pane)                    |
| `Home`                      | Default camera view                           |
| `A`                         | Frame the live gloves and Coil Pro            |
| `T` / `F` / `B` / `L` / `R` | Top / front / back / left / right camera view |
| `D`                         | Toggle the perf overlay (dev builds only)     |

`V` is the one to know about. The glove hub references yaw to magnetic north, so
which way the hands face on screen depends on where north was when the device
started and how your screen is turned relative to it — nothing the stream can
tell us. Hold both forearms out with your fingers pointing away from you and
press `V`. The captured heading is shared by both gloves and persists across
reloads.

The full list lives in one place — `src/ui/shortcuts.ts` — which the in-app
help renders.

The heading and the viewing slots only apply to hub-anchored poses, whose
origin is arbitrary. While a Coil Pro is tracking, each hand renders at its
physical position in the coil_pro frame instead, so both come off — and since
anchored hands can wander away from the camera, `A` moves the camera to frame
every live hand together with the Coil Pro.

The 3D pane also shows origin axes (X red, Y green/up, Z blue/depth) over a grid
of 5 cm cells with 25 cm sections, and a key in its bottom-right corner that draws
one of each for reference. Scene units are meters — a hand spans about
0.2. Bridge URL, layout, display mode, camera pose, and heading all persist
across reloads.

## Wire contract (bridge → browser)

The bridge translates RGMP framing into a hybrid of text and binary WS messages.
Text messages are tagged JSON:

```json
{ "type": "definition", "payload": { "device_id": 1, "groups": [ /* ... */ ] } }
{ "type": "disconnect", "device_id": 1 }
{ "type": "bridge_error", "payload": { "message": "..." } }
```

Data frames arrive as **binary** WS messages — a 16-byte little-endian inner
header followed by the group's tightly packed values:

```
<device_id u32><group_id u32><timestamp_us u64><packed stream values...>
```

The client unpacks the values using the layout from the matching `definition`.
See the RGMP spec (`/reference/rgmp` on the docs site) for the protocol itself.
