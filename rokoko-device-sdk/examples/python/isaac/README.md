# isaac

**Solved Smartgloves hands, consumed from NVIDIA Isaac Lab.**

`RokokoGloveDevice` is an Isaac Lab teleop device that impersonates the
stock `OpenXRDevice`: same raw-data contract (26 `XrHandJointEXT` joints
per hand, w-first quaternions, held poses on a stale hand), fed from
`rkk-hand-solver`'s RGMP v2 stream instead of an XR runtime. Because the
contract is identical, Isaac Lab's own `handtracking` retargeters and
teleop tasks work unchanged — only the device is swapped.

```
gloves ─► Rokoko driver ─► rkk-hand-solver --emit-openxr ──RGMP/TCP──► RokokoGloveDevice ─► Isaac Lab
                           :12277, 26 XrHandJointEXT joints             (this package)      retargeters,
                                                                                            teleop envs,
                                                                                            HDF5 recording
```

## What you need

- **`rkk-hand-solver`**, the hand-solving binary in the SDK's `bin/`
  directory, started with `--emit-openxr` so it publishes the
  `joints_openxr` group. The pure-Python solver next door
  (`../rgmp_hand_solver.py`) does **not** emit that group, so it cannot
  feed this device. Add `--listen 0.0.0.0:12277` when Isaac runs on
  another machine; the solver must be reachable *from* the Isaac host
  (a tunnel such as Tailscale beats exposing the port).
- **Isaac Lab 2.3.0** (`nvcr.io/nvidia/isaac-lab:2.3.0`, core `isaaclab`
  0.47.1, bundling Isaac Sim 5.1.0). That is the release the device and
  the tools below were validated against; the Isaac Lab internals they
  import are noted per script.
- This `python/` directory on `sys.path` on the Isaac host. The package
  imports the sibling `rgmp_core` package, so copy the whole tree, not
  just `isaac/`.

Everything except the `DeviceBase` subclass itself is pure Python with no
Isaac or numpy dependency, and `rokoko_glove_device.py` imports
`isaaclab` lazily, so the decode, rebase, and calibration code can be
read and exercised on any machine.

| Module | Role |
| --- | --- |
| `glove_stream.py` | `rkk-hand-solver`'s RGMP v2 stream → one latest `HandFrame` per hand |
| `frames.py` | `xr_base` (Y-up) → Isaac world (Z-up): one rigid transform per hand |
| `calibration.py` | the session inputs to that transform: yaw capture, wrist anchors |
| `rokoko_glove_device.py` | Isaac Lab `DeviceBase` shim impersonating `OpenXRDevice` |
| `tools/` | acceptance and recording scripts to run on the Isaac host (below) |

## Using the device

On an Isaac host, the device drops into Isaac Lab like the stock OpenXR
one:

```python
from isaac.rokoko_glove_device import RokokoGloveDevice, RokokoGloveDeviceCfg

device = RokokoGloveDevice(RokokoGloveDeviceCfg(host="<glove host>", port=12277))
device.calibrate()          # operator holds a hand toward workspace +X
data = device.advance()     # OpenXRDevice-shaped dict (or retargeted commands)
device.close()
```

`RokokoGloveDeviceCfg` also takes the two wrist anchor poses and the head
pose (Isaac Lab's 7-element `x y z qw qx qy qz` layout) and a
`facing_yaw_rad` for the calibration gesture. `calibrate()` can be bound
to an input via `add_callback("CALIBRATE", ...)` + `trigger("CALIBRATE")`.
`reset()` follows `OpenXRDevice.reset` (clears held poses) but keeps the
calibration — an env reset must not lose the session's yaw offset.

### The stream by itself

`GloveStream` runs the RGMP client on a background thread and keeps
exactly the newest decoded `joints_openxr` frame per hand. The depth-1
mailbox is deliberate: for realtime teleop a queued old pose is worse
than a dropped one, and a consumer stepping on its own clock (Isaac)
just wants the freshest frame each step.

```python
from isaac.glove_stream import GloveStream

with GloveStream("127.0.0.1", 12277) as stream:
    generation = stream.wait(0, timeout=5.0)      # first announce/frames
    for device_id, frame in stream.latest().items():
        print(frame.hand, frame.timestamp_us, frame.joints[0])
```

Values pass through in the solver's own terms, which is the wire
contract `--emit-openxr` publishes:

- the 26 `XrHandJointEXT` joints in enum order, named in snake_case
  without the `xr_` prefix (`palm`, `wrist`, `thumb_metacarpal`, …).
  These match `isaaclab.devices.openxr.common.HAND_JOINT_NAMES` exactly,
  so no mapping table is needed;
- one pose per joint against `xr_base`: the glove frame rotated +90°
  about X, so **Y is up**; position in meters, then quaternion
  **`x y z w`** (Isaac Lab wants `w x y z` — the shim reorders);
- **wrist-relative**: the wrist stays at the origin, so an anchor pose
  must place the hand in the workspace;
- **yaw is magnetic-north-referenced** with an arbitrary per-session
  zero, so pitch and roll are absolute but heading needs calibrating.

### Rebasing into the Isaac world

Getting from `xr_base` into Isaac's Z-up world takes one `HandRebase`
per hand, composed from a fixed +90° rotation about X and the two
session inputs `calibration.py` supplies:

```python
from isaac.calibration import FixedWristAnchor, capture_yaw_offset
from isaac.frames import HandRebase, Pose

# Once per session: operator holds a hand toward the workspace +X.
yaw = capture_yaw_offset(stream.latest()[device_id])

anchors = FixedWristAnchor(
    left=Pose(position=(0.1, 0.4, 0.8)),
    right=Pose(position=(0.1, -0.4, 0.8)),
)
rebase = {
    d: HandRebase.for_isaac(yaw, anchors.pose(info.hand))
    for d, info in stream.hands().items()
}
world_frame = rebase[device_id].apply(stream.latest()[device_id])
```

One yaw capture covers both hands — it corrects the shared magnetic
reference, not the hand. Heading spread on a real glove held still was
about 8° over 10 s (tremor plus sensor noise), so averaging the capture
over a short window instead of one frame is a worthwhile refinement.

`FixedWristAnchor` pins each wrist to a configured workspace pose, which
is enough for tabletop teleop where finger and wrist rotation drive the
robot. Arm travel needs a tracked anchor; `WristAnchor` is the protocol
to implement for one.

## Tools

`tools/` holds the scripts used to validate the device on an Isaac host.
They expect a solved-hand stream already up and `python/` on `sys.path`.
Each prints an `…-OK` line and exits 0 on success; the Isaac scripts exit
through a bounded teardown because `SimulationApp.close()` can hang in a
headless container.

- `isaac_device_check.py --host <solver host>` — constructs the device
  inside a real Isaac Lab app and verifies the OpenXR-shaped contract end
  to end (joint set, pose layout, finger motion). Takes `--hands` since a
  real session may have one glove.
- `isaac_gr1t2_retargeter_check.py` — drives Isaac Lab's `GR1T2Retargeter`
  (dex-retargeting onto the Fourier GR1T2 hands, using the task's own
  config) directly from the device and checks that all 36 output dims
  (2×7 wrist poses + 22 hand joints) are finite and moving.
- `isaac_teleop_record.py --task <task id> --steps N --out <dir>` —
  reuses a stock task's `handtracking` teleop configuration verbatim
  (retargeters instantiated via Isaac Lab's `RETARGETER_MAP`), swaps in
  `RokokoGloveDevice`, and records episodes to HDF5. Validated on
  `Isaac-Stack-Cube-Franka-IK-Rel-v0` and `Isaac-PickPlace-GR1T2-Abs-v0`.
  Pass `--livestream 1` to watch (see below). Note that it does not call
  `calibrate()`, so the yaw-to-arm direction runs on magnetic north
  unless you add the gesture.
- `measure_hop_latency.py` — taps the driver's stream and the solver's
  output side by side and reports the solver hop. Measured on one host:
  mean 0.09 ms, p95 0.12 ms, max 0.42 ms over 1656 samples — negligible;
  a remote glove host adds its network RTT on top.

Typical run inside the pinned container, with this `python/` tree mounted
at `/workspace/rokoko` and an output directory at `/out`:

```sh
./isaaclab.sh -p /workspace/rokoko/isaac/tools/isaac_teleop_record.py \
    --host <solver host> --port 12277 --task Isaac-Stack-Cube-Franka-IK-Rel-v0 \
    --steps 300 --out /out
```

## Isaac Lab 2.3.0 notes

Things the scripts handle that are worth knowing before touching the
GR1T2 tasks or writing your own env script:

- the `pick_place` package (all GR1T2 tasks) is blacklisted from
  `isaaclab_tasks`' bulk import — import it explicitly to register the
  tasks;
- **pinocchio must be imported before `AppLauncher`** (Isaac Lab's build
  must beat Isaac Sim's, the same reason `record_demos.py` has
  `--enable_pinocchio`), or Pink IK *and* `dex_retargeting` die with
  `TypeError: No Python class registered for C++ class std::vector<…>`;
- `retargeters/dex/DexRetargeter` is an unimplemented stub in this
  release — the humanoid retargeters (`GR1T2Retargeter`) are the real
  full-hand path;
- Isaac Lab's `GripperRetargeter` reads only the thumb-tip to index-tip
  distance: close below 3 cm, open above 5 cm, with hysteresis. A fist
  keeps the tips several centimetres apart and does nothing; a pinch
  works. A real glove spans roughly 0.5–11 cm on that distance;
- the Franka stack task's `Se3RelRetargeter` is configured with
  `use_wrist_position=True, use_wrist_rotation=False,
  zero_out_xy_rotation=True`, so with a fixed wrist anchor the only arm
  input is hand yaw — position deltas log as zero until a tracked anchor
  supplies arm travel;
- `EXPORT_ALL` also writes an empty trailing episode group once the
  env's time_out auto-reset fires — `isaac_teleop_record.py` counts only
  episodes with an `actions` dataset;
- the release `rkk-hand-solver` binary needs glibc ≥ 2.39; on an Ubuntu
  22.04 host run it in an `ubuntu:24.04` container on the host network.

## Running on a remote GPU host

The device was validated with the glove host (driver + solver) on a
laptop and Isaac Lab on a cloud GPU instance, joined by Tailscale. What
carried over:

- **Latency:** a ~99 ms RTT between the two ends was fine for recording
  (frames are source-stamped) but noticeable for closed-loop teleop feel.
  Pick a region near the operator.
- **Headless Isaac Sim** (`nvcr.io/nvidia/isaac-sim:5.1.0`) is viewed
  with NVIDIA's *Isaac Sim WebRTC Streaming Client*. Isaac Sim serves
  exactly one WebRTC client per instance and owns port 49100, so stop any
  standing streaming container before launching a session with
  `--livestream 1`. The firewall needs SSH (TCP 22), WebRTC signaling
  (TCP 49100) and media (UDP 47995–48012, 49100), restricted to the
  operator's address.
- **NVIDIA driver:** driver 595 crashed Isaac Sim 5.1's RTX renderer
  plugins at startup (breakpad fatal in `librtx.scenedb`, container
  restart loop). The 580 server branch (`nvidia-driver-580-server-open`,
  580.173.02) works.

A live-view launch looks like this, with `PUBLIC_IP` set to the address
the streaming client will connect to (Isaac Lab passes it through as
`--/app/livestream/publicEndpointAddress`):

```sh
docker run -d --name isaac-lab-live --gpus all --network host \
  -e ACCEPT_EULA=Y -e PRIVACY_CONSENT=N -e PUBLIC_IP=<public ip> \
  -v ~/rokoko:/workspace/rokoko -v ~/rokoko-out:/out \
  -v ~/docker/isaac-lab/cache/kit:/isaac-sim/kit/cache \
  -v ~/docker/isaac-lab/cache/ov:/root/.cache/ov \
  -v ~/docker/isaac-lab/cache/glcache:/root/.cache/nvidia/GLCache \
  -v ~/docker/isaac-lab/cache/computecache:/root/.nv/ComputeCache \
  --entrypoint bash nvcr.io/nvidia/isaac-lab:2.3.0 -c \
  "cd /workspace/isaaclab && ./isaaclab.sh -p \
     /workspace/rokoko/isaac/tools/isaac_teleop_record.py \
     --host <solver host> --task Isaac-PickPlace-GR1T2-Abs-v0 \
     --livestream 1 --steps 100000 --out /out 2>&1 | tee /out/live.log"
```

Port 49100 opens about 30 s in; the scene is stepping once the log says
`app ready` (roughly 2.5 min for GR1T2, 1 min for Franka). With
`--livestream` the recorder also prints the action vector once a second
and keeps the retargeters' debug markers on. Restarting the session
restarts the stream server, so reconnect the client after every
relaunch.

## Tests

The package's unit tests, the mock-driver chain they stand up, and the
regression fixture are not part of the SDK.
