"""Isaac Lab device shim: solved Smartgloves as an OpenXR-shaped
teleop device.

`RokokoGloveDevice` impersonates Isaac Lab's `OpenXRDevice` — same raw
data contract, fed from `rkk-hand-solver`'s RGMP stream instead of an XR
runtime (`isaaclab.devices.openxr.manus_vive` does the same for Manus
gloves and is the pattern followed here). The contract, per
`OpenXRDevice._get_raw_data` (Isaac Lab 2.3.0):

- a dict keyed by `OpenXRDevice.TrackingTarget` (HAND_LEFT, HAND_RIGHT,
  HEAD);
- each hand: `{joint_name: np.float32[7]}` over the 26
  `HAND_JOINT_NAMES`, pose layout `[x, y, z, qw, qx, qy, qz]` — note
  **w-first** quaternions, while the wire (and `HandFrame`) is x y z w;
- a hand with no fresh data **holds** its previous poses;
- HEAD is a single 7-pose (we have no headset — it is a fixed
  configured pose).

The module stays importable without Isaac Lab: the conversion helpers
are pure stdlib (unit-tested in this repo's CI), and only the
`DeviceBase` subclass needs `isaaclab` + numpy, which are imported
lazily. Constructing the device without them raises with instructions.

Calibration: `calibrate()` captures the per-session yaw offset from the
operator gesture (hand held toward the workspace +X — see
`calibration.capture_yaw_offset`) and rebuilds both hands' rebases.
`reset()` follows `OpenXRDevice.reset` semantics (clears cached poses)
and deliberately keeps the calibration — an env reset must not lose it.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Any

from isaac.calibration import FixedWristAnchor, capture_yaw_offset
from isaac.frames import HandRebase, Pose
from isaac.glove_stream import DEFAULT_PORT, GloveStream, HandFrame

log = logging.getLogger("rokoko.isaac.device")

# Pose layout used by Isaac Lab devices: x y z qw qx qy qz.
DEFAULT_POSE7 = (0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0)

HAND_SIDES = ("left", "right")


# ── Pure helpers (no Isaac Lab, no numpy) ─────────────────────────────────────


def pose7_wxyz(position: tuple[float, ...], orientation_xyzw: tuple[float, ...]) -> tuple[float, ...]:
    """Wire/`HandFrame` pose (position + x y z w quaternion) → Isaac Lab's
    7-element layout [x, y, z, qw, qx, qy, qz]."""
    x, y, z = position
    qx, qy, qz, qw = orientation_xyzw
    return (x, y, z, qw, qx, qy, qz)


def pose_from_pose7(pose7: tuple[float, ...]) -> Pose:
    """The inverse direction, for configuration values given in Isaac
    Lab's layout: 7 elements [x, y, z, qw, qx, qy, qz] → `frames.Pose`."""
    x, y, z, qw, qx, qy, qz = pose7
    return Pose(position=(x, y, z), orientation=(qx, qy, qz, qw))


def joint_poses_wxyz(frame: HandFrame, rebase: HandRebase) -> dict[str, tuple[float, ...]]:
    """One rebased hand as `{joint_name: pose7}` in Isaac Lab's layout."""
    rebased = rebase.apply(frame)
    return {j.name: pose7_wxyz(j.position, j.orientation) for j in rebased.joints}


def newest_per_side(frames: dict[int, HandFrame]) -> dict[str, HandFrame]:
    """Newest frame per hand side. Two gloves announcing the same side
    (unusual, but possible mid-swap) resolve to the newer timestamp;
    sides other than left/right are ignored."""
    per_side: dict[str, HandFrame] = {}
    for frame in frames.values():
        if frame.hand not in HAND_SIDES:
            continue
        held = per_side.get(frame.hand)
        if held is None or frame.timestamp_us > held.timestamp_us:
            per_side[frame.hand] = frame
    return per_side


# ── The Isaac Lab device ──────────────────────────────────────────────────────

try:  # deliberately lazy: this repo's CI has neither isaaclab nor numpy
    import numpy as np
    from isaaclab.devices import DeviceBase, DeviceCfg
    from isaaclab.devices.openxr.common import HAND_JOINT_NAMES
    from isaaclab.devices.openxr.openxr_device import OpenXRDevice

    _ISAACLAB_ERROR: ModuleNotFoundError | None = None
except ModuleNotFoundError as exc:  # pragma: no cover - exercised on Isaac hosts only
    _ISAACLAB_ERROR = exc
    DeviceBase = object  # type: ignore[assignment,misc]
    DeviceCfg = object  # type: ignore[assignment,misc]


@dataclass
class _GloveSettings:
    """The Rokoko-specific configuration, shared by both cfg variants."""

    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    facing_yaw_rad: float = 0.0
    # Poses below are in Isaac Lab's 7-element layout: x y z qw qx qy qz.
    wrist_anchor_left: tuple[float, ...] = DEFAULT_POSE7
    wrist_anchor_right: tuple[float, ...] = DEFAULT_POSE7
    head_pose: tuple[float, ...] = DEFAULT_POSE7


if _ISAACLAB_ERROR is None:

    @dataclass
    class RokokoGloveDeviceCfg(_GloveSettings, DeviceCfg):
        """Configuration for `RokokoGloveDevice`."""

    class RokokoGloveDevice(DeviceBase):
        """Solved Smartgloves as an Isaac Lab teleop device.

        Raw data format and teleop-command callback keys are consistent
        with :class:`OpenXRDevice`, so its retargeters work unchanged.
        The extra surface is `calibrate()` (bindable via
        `add_callback("CALIBRATE", ...)` + `trigger("CALIBRATE")`, e.g.
        from a keyboard handler in the env script) and `close()`.
        """

        TrackingTarget = OpenXRDevice.TrackingTarget

        def __init__(self, cfg: RokokoGloveDeviceCfg, retargeters=None):
            super().__init__(retargeters)
            self._cfg = cfg
            self._lock = threading.Lock()
            self._yaw_offset = 0.0
            self._anchors = FixedWristAnchor(
                left=pose_from_pose7(cfg.wrist_anchor_left),
                right=pose_from_pose7(cfg.wrist_anchor_right),
            )
            self._rebases = self._build_rebases()
            self._previous = {
                side: {name: self._default_pose() for name in HAND_JOINT_NAMES}
                for side in HAND_SIDES
            }
            self._head_pose = np.array(cfg.head_pose, dtype=np.float32)
            self._additional_callbacks: dict[str, Any] = {}
            self._stream = GloveStream(cfg.host, cfg.port)
            self._stream.start()

        @staticmethod
        def _default_pose() -> "np.ndarray":
            return np.array(DEFAULT_POSE7, dtype=np.float32)

        def _build_rebases(self) -> dict[str, HandRebase]:
            return {
                side: HandRebase.for_isaac(self._yaw_offset, self._anchors.pose(side))
                for side in HAND_SIDES
            }

        # ── DeviceBase surface ────────────────────────────────────────────────

        def reset(self):
            """Clear cached joint poses (calibration is kept — an env
            reset must not lose the session's yaw offset)."""
            with self._lock:
                self._previous = {
                    side: {name: self._default_pose() for name in HAND_JOINT_NAMES}
                    for side in HAND_SIDES
                }

        def add_callback(self, key: str, func):
            """Register a callback ("START"/"STOP"/"RESET"/"CALIBRATE");
            fire them with `trigger()` from whatever input the env script
            uses (there is no XR message bus behind this device)."""
            self._additional_callbacks[key] = func

        def trigger(self, key: str):
            """Fire a registered callback by key. "CALIBRATE" also runs
            the device's own calibration first."""
            if key == "CALIBRATE":
                self.calibrate()
            callback = self._additional_callbacks.get(key)
            if callback is not None:
                callback()

        def _get_raw_data(self) -> dict:
            frames = newest_per_side(self._stream.latest())
            with self._lock:
                for side, frame in frames.items():
                    poses = joint_poses_wxyz(frame, self._rebases[side])
                    previous = self._previous[side]
                    for name, pose7 in poses.items():
                        if name in previous:
                            previous[name] = np.array(pose7, dtype=np.float32)
                return {
                    self.TrackingTarget.HAND_LEFT: self._previous["left"],
                    self.TrackingTarget.HAND_RIGHT: self._previous["right"],
                    self.TrackingTarget.HEAD: self._head_pose,
                }

        # ── Rokoko-specific surface ───────────────────────────────────────────

        def calibrate(self, facing_yaw_rad: float | None = None) -> bool:
            """Capture the session yaw offset from the current pose of
            whichever hand has data (the operator gesture: hand held
            toward the workspace +X, roughly level). Returns True when
            the offset was captured and applied."""
            facing = self._cfg.facing_yaw_rad if facing_yaw_rad is None else facing_yaw_rad
            frames = newest_per_side(self._stream.latest())
            newest = max(frames.values(), key=lambda f: f.timestamp_us, default=None)
            if newest is None:
                log.warning("calibrate: no hand frames yet — is the solver reachable?")
                return False
            try:
                offset = capture_yaw_offset(newest, facing_yaw_rad=facing)
            except ValueError as exc:
                log.warning("calibrate: %s", exc)
                return False
            with self._lock:
                self._yaw_offset = offset
                self._rebases = self._build_rebases()
            log.info(
                "calibrated yaw offset to %.3f rad from the %s hand", offset, newest.hand
            )
            return True

        @property
        def connected(self) -> bool:
            return self._stream.connected

        def close(self):
            self._stream.stop()

        def __del__(self):
            try:
                self.close()
            except Exception:
                pass

else:

    @dataclass
    class RokokoGloveDeviceCfg(_GloveSettings):  # type: ignore[no-redef]
        """Configuration for `RokokoGloveDevice` (Isaac Lab not installed)."""

    class RokokoGloveDevice:  # type: ignore[no-redef]
        """Placeholder that explains itself: the real device needs Isaac Lab."""

        def __init__(self, *args, **kwargs):
            raise ModuleNotFoundError(
                "RokokoGloveDevice needs Isaac Lab (and numpy) — run inside an "
                "Isaac Lab python environment, e.g. the nvcr.io/nvidia/isaac-lab "
                "container pinned in python/isaac/README.md"
            ) from _ISAACLAB_ERROR
