"""Humanoid full-hand retargeting check, run on the Isaac host:
`GR1T2Retargeter` (dex-retargeting onto the Fourier GR1T2's hands)
consuming `RokokoGloveDevice` raw data directly.

Why not the full GR1T2 task, like the Franka run: in Isaac Lab 2.3.0
the pick_place package is blacklisted for a reason — constructing its
Pink IK action crashes in pinocchio's bindings
("No Python class registered for C++ class std::vector<string>", from
`pink_kinematics_configuration.py`) inside the pinned container. The
hand retargeter itself has no pinocchio dependency, so the device →
humanoid-retargeter contract is validated standalone; the env-level
path (actions → recording) is already proven by the Franka run.

The retargeter cfg (incl. the 22 GR1T2 hand joint names) is taken from
the task's own `handtracking` entry, so this stays NVIDIA's
configuration, not ours.

    ./isaaclab.sh -p /workspace/rokoko/isaac/tools/isaac_gr1t2_retargeter_check.py \\
        --host 127.0.0.1 --port 12277

Prints `ROKOKO-GR1T2-RETARGET-OK <dim>` on success; bounded teardown as
in the other checks.
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
parser.add_argument("--task", default="Isaac-PickPlace-GR1T2-Abs-v0")
parser.add_argument(
    "--livestream",
    type=int,
    default=0,
    choices=(0, 1, 2),
    help="Isaac Lab AppLauncher livestream mode: 0 off, 1 WebRTC public "
    "network (set PUBLIC_IP to the host's public address), 2 private network",
)
parser.add_argument("--steps", type=int, default=100)
args = parser.parse_args()

# Pinocchio must be imported before AppLauncher to get Isaac Lab's build
# instead of Isaac Sim's (its boost-python registrations clash after kit
# loads) — same workaround, same comment, as scripts/tools/record_demos.py
# behind --enable_pinocchio. Without it, dex_retargeting dies with
# "No Python class registered for C++ class std::vector<int>".
import pinocchio  # noqa: F401

from isaaclab.app import AppLauncher  # noqa: E402  (kit must boot first)

app = AppLauncher(headless=True, livestream=args.livestream).app

import gymnasium as gym  # noqa: E402
import torch  # noqa: E402

import isaaclab_tasks  # noqa: F401, E402

if args.task not in gym.registry:
    # Blacklisted in the bulk import (pinocchio TODO); the cfg itself
    # imports fine — only Pink IK construction is broken.
    import isaaclab_tasks.manager_based.manipulation.pick_place  # noqa: F401, E402

from isaaclab.devices.teleop_device_factory import RETARGETER_MAP  # noqa: E402
from isaaclab_tasks.utils.parse_cfg import parse_env_cfg  # noqa: E402

from isaac.rokoko_glove_device import RokokoGloveDevice, RokokoGloveDeviceCfg  # noqa: E402


def bounded_exit(code: int) -> None:
    threading.Timer(20.0, lambda: os._exit(code)).start()
    try:
        app.close()
    finally:
        os._exit(code)


def fail(message: str) -> None:
    print(f"ROKOKO-GR1T2-RETARGET-FAIL: {message}", flush=True)
    bounded_exit(1)


env_cfg = parse_env_cfg(args.task, device="cuda:0", num_envs=1)
retargeter_cfg = env_cfg.teleop_devices.devices["handtracking"].retargeters[0]
retargeter_cfg.enable_visualization = False  # markers need a scene; there is none
retargeter = RETARGETER_MAP[type(retargeter_cfg)](retargeter_cfg)

device = RokokoGloveDevice(
    RokokoGloveDeviceCfg(
        host=args.host,
        port=args.port,
        wrist_anchor_left=(0.3, 0.3, 1.1, 1.0, 0.0, 0.0, 0.0),
        wrist_anchor_right=(0.3, -0.3, 1.1, 1.0, 0.0, 0.0, 0.0),
    ),
    retargeters=[retargeter],
)

deadline = time.monotonic() + 15.0
while time.monotonic() < deadline and not device.connected:
    time.sleep(0.2)
if not device.connected:
    fail(f"never connected to rgmp://{args.host}:{args.port}")
time.sleep(1.0)  # first frames

outputs = []
for _ in range(args.steps):
    outputs.append(device.advance())
    time.sleep(0.02)

first, last = outputs[0], outputs[-1]
if not isinstance(last, torch.Tensor):
    fail(f"advance() returned {type(last).__name__}, expected torch.Tensor")
if first.shape != last.shape:
    fail(f"output shape changed mid-run: {first.shape} -> {last.shape}")
dim = last.shape[-1]
hand_joints = len(retargeter_cfg.hand_joint_names)
if dim < hand_joints:
    fail(f"output dim {dim} < {hand_joints} configured hand joints")
if not torch.isfinite(last).all():
    fail("non-finite values in retargeted output")
if (last - first).abs().max().item() < 1e-4:
    fail("retargeted output never moved — mock finger curl should drive it")

device.close()
print(f"ROKOKO-GR1T2-RETARGET-OK {dim}", flush=True)
bounded_exit(0)
