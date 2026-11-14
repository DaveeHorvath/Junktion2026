"""Phase-4 acceptance check, run on the Isaac host: construct
`RokokoGloveDevice` inside a real Isaac Lab app, read the mock chain
through it, and verify the OpenXR-shaped contract end to end.

Expects a solved-hand stream already up (mock chain or real), and the
repo's `python/` on sys.path. Typical run inside the pinned isaac-lab
container, with the chain on the host network:

    ./isaaclab.sh -p /workspace/rokoko/isaac/tools/isaac_device_check.py \\
        --host 127.0.0.1 --port 12277

Prints `ROKOKO-DEVICE-CHECK-OK` and exits 0 on success. Exits via
`os._exit` after a bounded teardown — `SimulationApp.close()` can hang
in the headless container (see python/isaac/README.md).
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

parser = argparse.ArgumentParser()
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=12277)
parser.add_argument("--steps", type=int, default=100)
parser.add_argument("--hands", type=int, default=2, choices=(1, 2))
args = parser.parse_args()

from isaaclab.app import AppLauncher  # noqa: E402  (kit must boot first)

app = AppLauncher(headless=True).app

import numpy as np  # noqa: E402

from isaaclab.devices.openxr.common import HAND_JOINT_NAMES  # noqa: E402

from isaac.rokoko_glove_device import RokokoGloveDevice, RokokoGloveDeviceCfg  # noqa: E402


def bounded_exit(code: int) -> None:
    """Try a clean close, but never hang on it."""
    threading.Timer(20.0, lambda: os._exit(code)).start()
    try:
        app.close()
    finally:
        os._exit(code)


def fail(message: str) -> None:
    print(f"ROKOKO-DEVICE-CHECK-FAIL: {message}", flush=True)
    bounded_exit(1)


device = RokokoGloveDevice(
    RokokoGloveDeviceCfg(
        host=args.host,
        port=args.port,
        wrist_anchor_left=(0.1, 0.4, 0.8, 1.0, 0.0, 0.0, 0.0),
        wrist_anchor_right=(0.1, -0.4, 0.8, 1.0, 0.0, 0.0, 0.0),
    )
)

# Give the stream a moment to announce and deliver first frames.
deadline = time.monotonic() + 15.0
while time.monotonic() < deadline and not device.connected:
    time.sleep(0.2)
if not device.connected:
    fail(f"never connected to rgmp://{args.host}:{args.port}")

deadline = time.monotonic() + 30.0
while time.monotonic() < deadline and len(device._stream.hands()) < args.hands:
    time.sleep(0.2)
sides = {info.hand for info in device._stream.hands().values()}
if len(sides) < args.hands:
    fail(f"expected {args.hands} hand(s), stream announces {sorted(sides) or 'none'}")

Target = RokokoGloveDevice.TrackingTarget
targets = [t for side, t in (("left", Target.HAND_LEFT), ("right", Target.HAND_RIGHT)) if side in sides]
first: dict[Target, dict[str, np.ndarray]] | None = None
last = None
for _ in range(args.steps):
    last = device.advance()
    if first is None:
        first = {t: {n: p.copy() for n, p in last[t].items()} for t in targets}
    time.sleep(0.02)

for target in targets:
    joints = last[target]
    if set(joints) != set(HAND_JOINT_NAMES):
        fail(f"{target}: joint names differ from HAND_JOINT_NAMES")
    for name, pose in joints.items():
        if pose.shape != (7,) or pose.dtype != np.float32:
            fail(f"{target}/{name}: pose is {pose.dtype}{pose.shape}, want float32(7,)")
        if not np.isfinite(pose).all():
            fail(f"{target}/{name}: non-finite pose")
    # The wrist sits exactly at its configured anchor.
    expected_y = 0.4 if target is Target.HAND_LEFT else -0.4
    wrist = joints["wrist"]
    if not (abs(wrist[0] - 0.1) < 1e-5 and abs(wrist[1] - expected_y) < 1e-5 and abs(wrist[2] - 0.8) < 1e-5):
        fail(f"{target}: wrist at {wrist[:3]}, expected anchor (0.1, {expected_y}, 0.8)")
    # The mock animates the fingers, so index_tip must have moved.
    moved = float(np.linalg.norm(last[target]["index_tip"][:3] - first[target]["index_tip"][:3]))
    if moved < 1e-4:
        fail(f"{target}: index_tip never moved ({moved=})")

device.close()
print("ROKOKO-DEVICE-CHECK-OK", flush=True)
bounded_exit(0)
