"""Phase-5 validation, run on the Isaac host: drive a stock Isaac Lab
teleop task from solved gloves and record the episode to HDF5.

The task's own `handtracking` teleop configuration is reused verbatim —
its retargeter cfgs are instantiated through Isaac Lab's own
RETARGETER_MAP — and only the device is swapped: `RokokoGloveDevice`
where `OpenXRDevice` would be. That is the whole point of the shim; no
retargeting or recording code of ours is involved.

With the mock chain as the source, the wrist is anchored (wrist-relative
stream, no Coil Pro), so the recorded motion is mostly gripper
open/close from the mock's finger curl — enough to prove
device → retargeters → env actions → HDF5 end to end. Real arm motion
needs real gloves plus a tracked wrist anchor.

Typical run inside the pinned isaac-lab container (see
python/isaac/README.md), with `~/rokoko-out` mounted read-write:

    ./isaaclab.sh -p /workspace/rokoko/isaac/tools/isaac_teleop_record.py \\
        --host 127.0.0.1 --port 12277 --steps 300 --out /out

Prints `ROKOKO-TELEOP-RECORD-OK <episodes> <steps>` on success; exits
via a bounded teardown (kit close can hang headless).
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
parser.add_argument("--task", default="Isaac-Stack-Cube-Franka-IK-Rel-v0")
parser.add_argument(
    "--livestream",
    type=int,
    default=0,
    choices=(0, 1, 2),
    help="Isaac Lab AppLauncher livestream mode: 0 off, 1 WebRTC public "
    "network (set PUBLIC_IP to the host's public address), 2 private network",
)
parser.add_argument("--steps", type=int, default=300)
parser.add_argument("--out", default="/out")
args = parser.parse_args()

# Pinocchio before AppLauncher: forces Isaac Lab's build over Isaac Sim's
# (see record_demos.py's --enable_pinocchio); required for Pink IK tasks
# such as the GR1T2 ones. Harmless for tasks that never touch it.
import pinocchio  # noqa: F401

from isaaclab.app import AppLauncher  # noqa: E402  (kit must boot first)

app = AppLauncher(headless=True, livestream=args.livestream).app

import gymnasium as gym  # noqa: E402
import torch  # noqa: E402

import isaaclab_tasks  # noqa: F401, E402  (registers the tasks)

if args.task not in gym.registry:
    # Isaac Lab 2.3.0 blacklists the pick_place package (GR1T2 tasks) in
    # its bulk import over a pinocchio-compat TODO, but it imports fine
    # in the pinned container — register it explicitly.
    import isaaclab_tasks.manager_based.manipulation.pick_place  # noqa: F401, E402
from isaaclab.devices.teleop_device_factory import RETARGETER_MAP  # noqa: E402
from isaaclab.envs.mdp.recorders.recorders_cfg import ActionStateRecorderManagerCfg  # noqa: E402
from isaaclab.managers import DatasetExportMode  # noqa: E402
from isaaclab_tasks.utils.parse_cfg import parse_env_cfg  # noqa: E402

from isaac.rokoko_glove_device import RokokoGloveDevice, RokokoGloveDeviceCfg  # noqa: E402


def bounded_exit(code: int) -> None:
    threading.Timer(30.0, lambda: os._exit(code)).start()
    try:
        app.close()
    finally:
        os._exit(code)


def fail(message: str) -> None:
    print(f"ROKOKO-TELEOP-RECORD-FAIL: {message}", flush=True)
    bounded_exit(1)


dataset_file = "rokoko_teleop_demo.hdf5"
env_cfg = parse_env_cfg(args.task, device="cuda:0", num_envs=1)
env_cfg.recorders = ActionStateRecorderManagerCfg()
env_cfg.recorders.dataset_export_dir_path = args.out
env_cfg.recorders.dataset_filename = dataset_file
# The mock never satisfies the task's success term; export every episode.
env_cfg.recorders.dataset_export_mode = DatasetExportMode.EXPORT_ALL

env = gym.make(args.task, cfg=env_cfg).unwrapped

handtracking = env_cfg.teleop_devices.devices.get("handtracking")
if handtracking is None:
    fail(f"task {args.task} defines no 'handtracking' teleop device")
for rc in handtracking.retargeters:
    if getattr(rc, "enable_visualization", False):
        # debug markers: pointless headless, useful on a livestream
        rc.enable_visualization = args.livestream != 0
retargeters = [RETARGETER_MAP[type(rc)](rc) for rc in handtracking.retargeters]

device = RokokoGloveDevice(
    RokokoGloveDeviceCfg(
        host=args.host,
        port=args.port,
        wrist_anchor_left=(0.3, 0.3, 0.4, 1.0, 0.0, 0.0, 0.0),
        wrist_anchor_right=(0.3, -0.3, 0.4, 1.0, 0.0, 0.0, 0.0),
    ),
    retargeters=retargeters,
)

deadline = time.monotonic() + 15.0
while time.monotonic() < deadline and not device.connected:
    time.sleep(0.2)
if not device.connected:
    fail(f"never connected to rgmp://{args.host}:{args.port}")

env.sim.reset()
env.reset()
device.reset()

actions_seen = set()
next_log = 0.0
with torch.inference_mode():
    for _ in range(args.steps):
        action = device.advance()
        actions_seen.add(tuple(round(float(v), 4) for v in action.flatten().tolist()))
        if args.livestream and time.monotonic() >= next_log:
            # Live sessions: show what the retargeters emit, once a second.
            next_log = time.monotonic() + 1.0
            print("ACTION", [round(float(v), 3) for v in action.flatten().tolist()], flush=True)
        env.step(action.repeat(env.num_envs, 1))
    env.reset()  # flush the recorded episode to the dataset

if len(actions_seen) < 2:
    fail("actions never varied — retargeters saw no hand motion")

dataset_path = Path(args.out) / dataset_file
if not dataset_path.exists():
    fail(f"no dataset written at {dataset_path}")

import h5py  # noqa: E402

with h5py.File(dataset_path, "r") as f:
    # EXPORT_ALL also exports the empty post-final-reset episode as a
    # group with no datasets (seen with real gloves once the env's
    # time_out auto-reset fires mid-run) — count only real episodes.
    episodes = [ep for ep in f.get("data", {}) if "actions" in f["data"][ep]]
    total_steps = sum(f["data"][ep]["actions"].shape[0] for ep in episodes)
if not episodes or total_steps == 0:
    fail(f"dataset at {dataset_path} holds no recorded steps")

device.close()
print(f"ROKOKO-TELEOP-RECORD-OK {len(episodes)} {total_steps}", flush=True)
bounded_exit(0)
