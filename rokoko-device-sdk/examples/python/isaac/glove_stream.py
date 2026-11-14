"""Transport for solved hands: rkk-hand-solver's RGMP v2 stream -> a
latest-sample mailbox per hand.

`GloveStream` runs `RgmpClient` in a background thread against the
solver's output port (`:12277`) and keeps exactly the newest decoded
`joints_openxr` frame per solved hand. A consumer that steps on its own
clock — Isaac stepping the simulation — calls `latest()` and gets the
freshest frame for every hand, with stale frames silently superseded.
The mailbox depth of 1 is by design, not a shortcut: the solver is built
for lossy consumers (one that falls behind loses frames and is re-sent
the stream definitions), and for realtime teleop a queued old pose is
worse than a dropped one.

What this module does *not* do — deliberately, so it stays pure and
CI-testable without Isaac:

- no coordinate rebase or yaw calibration (`frames.py`, phase 3);
- no wrist anchoring (`calibration.py`, phase 3);
- no Isaac Lab types (`rokoko_glove_device.py`, phase 4).

Values pass through in the solver's own terms: transforms against the
Y-up `xr_base` frame, position in meters then quaternion x y z w,
wrist-relative, yaw magnetic-north-referenced.

Run `rkk-hand-solver --emit-openxr`; a solved hand announced without the
`joints_openxr` group is reported once and ignored.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Any

from rgmp_core.client import RgmpClient
from rgmp_core.layout import StreamLayout, StreamSlot, read_slot

log = logging.getLogger("rokoko.isaac.glove_stream")

DEFAULT_PORT = 12277

SOLVED_HAND_DEVICE_TYPE = "solved_hand"
XR_FRAME_PREFIX = "xr_"
OPENXR_GROUP_NAME = "joints_openxr"
RADIUS_LABEL = "joint_radius"


@dataclass(frozen=True)
class JointPose:
    """One OpenXR joint, as emitted: `xr_base` frame (Y-up), meters."""

    name: str  # XrHandJointEXT name, snake_case, no xr_ prefix
    position: tuple[float, float, float]
    orientation: tuple[float, float, float, float]  # quaternion, x y z w


@dataclass(frozen=True)
class HandFrame:
    """One decoded `joints_openxr` sample for one solved hand."""

    device_id: int
    hand: str  # "left" | "right"
    timestamp_us: int  # source glove's, passed through by the solver
    joints: tuple[JointPose, ...]  # XrHandJointEXT enum order


@dataclass(frozen=True)
class HandInfo:
    """Per-session facts about one announced solved hand.

    `joint_radii` comes from the CUSTOM/joint_radius entries in
    `static_data`; `definition` is the full parsed definition for anything
    not given a field here (the rest pose in `static_data`, solver
    version, ...).
    """

    device_id: int
    hand: str
    timestamp_epoch: str | None
    source_device_id: int | None
    joint_names: tuple[str, ...]  # XrHandJointEXT enum order
    joint_radii: dict[str, float]  # joint name -> meters
    definition: dict[str, Any]


@dataclass(frozen=True)
class _DecodePlan:
    """How to turn one device's `joints_openxr` payload into a HandFrame."""

    group_id: int
    slots: list[StreamSlot]
    joint_names: tuple[str, ...]
    payload_size: int
    hand: str


class GloveStream:
    """Background consumer of solved hands, one latest frame per hand.

    Usage::

        with GloveStream(host, port) as stream:
            gen = stream.wait(0, timeout=5.0)   # first frames arrived
            for device_id, frame in stream.latest().items():
                ...

    `latest()` and `hands()` never block and never raise; connection
    trouble shows up as hands disappearing (and `connected` going False)
    while the background thread reconnects with backoff. `wait(seen)`
    blocks until the state generation moves past `seen` — new frame,
    hand announced, hand dropped — for callers that want pacing.
    """

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = DEFAULT_PORT,
        connect_timeout: float = 5.0,
        reconnect_delay: float = 0.5,
    ) -> None:
        self.host = host
        self.port = port
        self._connect_timeout = connect_timeout
        self._reconnect_delay = reconnect_delay

        self._cond = threading.Condition()
        self._infos: dict[int, HandInfo] = {}
        self._plans: dict[int, _DecodePlan] = {}
        self._frames: dict[int, HandFrame] = {}
        self._generation = 0
        self._connected = False

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._client: RgmpClient | None = None
        self._warned: set[tuple[int, str]] = set()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("GloveStream is already started")
        self._thread = threading.Thread(
            target=self._run, name="rokoko-glove-stream", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        client = self._client
        if client is not None:
            # Closing the socket from here unblocks the reader thread's recv.
            try:
                client.__exit__(None, None, None)
            except OSError:
                pass
        with self._cond:
            self._cond.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
            self._thread = None

    def __enter__(self) -> "GloveStream":
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.stop()

    # ── Consumer surface ──────────────────────────────────────────────────────

    @property
    def connected(self) -> bool:
        with self._cond:
            return self._connected

    def hands(self) -> dict[int, HandInfo]:
        """Currently announced solved hands, keyed by device id (the
        source glove's, so left/right correlation is free)."""
        with self._cond:
            return dict(self._infos)

    def latest(self) -> dict[int, HandFrame]:
        """The newest frame per hand. Non-blocking; empty until the first
        data frame after a (re)connect."""
        with self._cond:
            return dict(self._frames)

    def wait(self, seen: int = 0, timeout: float | None = None) -> int:
        """Block until the state generation differs from `seen` (or the
        stream is stopped), and return the new generation — pass it back
        in as `seen` next time. Raises TimeoutError if nothing happens
        within `timeout`."""
        with self._cond:
            changed = self._cond.wait_for(
                lambda: self._generation != seen or self._stop.is_set(), timeout
            )
            if not changed:
                raise TimeoutError(
                    f"no update from rgmp://{self.host}:{self.port} "
                    f"within {timeout}s"
                )
            return self._generation

    # ── Background thread ─────────────────────────────────────────────────────

    def _run(self) -> None:
        delay = self._reconnect_delay
        while not self._stop.is_set():
            try:
                with RgmpClient(
                    self.host, self.port, timeout=self._connect_timeout
                ) as client:
                    self._client = client
                    # The timeout above bounds connect(); the stream itself
                    # may legitimately idle (no gloves yet), so recv must not
                    # time out.
                    client._socket.settimeout(None)
                    client.on_definition = self._on_definition
                    client.on_data = self._on_data
                    client.on_disconnect = self._on_disconnect
                    delay = self._reconnect_delay
                    self._set_connected(True)
                    log.info(
                        "connected to solver at rgmp://%s:%s", self.host, self.port
                    )
                    client.run()
            except OSError as exc:
                self._warn_once(0, f"connect:{type(exc).__name__}", str(exc))
            except RuntimeError:
                # stop() closes the client from another thread; the reader
                # can then see RgmpClient's "not connected" guard instead
                # of a socket error. Only expected while stopping.
                if not self._stop.is_set():
                    raise
            finally:
                self._client = None
                # The peer is gone; announced hands go with it and will
                # re-announce on reconnect (the solver re-sends definitions).
                self._drop_all_hands()
            if self._stop.is_set():
                return
            self._stop.wait(delay)
            delay = min(delay * 2.0, 10.0)

    def _set_connected(self, connected: bool) -> None:
        with self._cond:
            self._connected = connected

    def _drop_all_hands(self) -> None:
        with self._cond:
            self._connected = False
            if self._infos or self._frames:
                self._infos.clear()
                self._plans.clear()
                self._frames.clear()
                self._generation += 1
                self._cond.notify_all()

    def _warn_once(self, device_id: int, key: str, message: str) -> None:
        if (device_id, key) in self._warned:
            return
        self._warned.add((device_id, key))
        log.warning("%s", message)

    # ── RgmpClient callbacks (reader thread) ──────────────────────────────────

    def _on_definition(self, definition: dict[str, Any], layout: StreamLayout) -> None:
        if definition.get("device_type") != SOLVED_HAND_DEVICE_TYPE:
            # The solver's port carries solved hands only; be defensive anyway.
            return
        device_id = int(definition["device_id"])
        info = definition.get("device_info") or {}

        openxr = info.get("openxr")
        if not isinstance(openxr, dict):
            self._warn_once(
                device_id,
                "no-openxr",
                f"solved hand {device_id} announces no OpenXR layout — "
                f"run rkk-hand-solver with --emit-openxr",
            )
            return

        group_name = openxr.get("group", OPENXR_GROUP_NAME)
        # Group ids are positional and shift with the solver's --emit flags,
        # so the group is located by name, never assumed.
        group_id = next(
            (gid for gid, name in layout.group_names.items() if name == group_name),
            None,
        )
        if group_id is None:
            self._warn_once(
                device_id,
                "no-openxr-group",
                f"solved hand {device_id}: device_info.openxr names group "
                f"{group_name!r} but the definition has no such group",
            )
            return

        slots = layout.groups[group_id]
        joint_names = tuple(
            str(slot.entry["target_frame"]).removeprefix(XR_FRAME_PREFIX)
            for slot in slots
            if slot.entry is not None
        )
        payload_size = slots[-1].offset + slots[-1].byte_size if slots else 0

        radius_label = openxr.get("radius_label", RADIUS_LABEL)
        radii: dict[str, float] = {}
        for entry in definition.get("static_data") or []:
            if entry.get("custom_label") != radius_label:
                continue
            value = entry.get("value")
            if isinstance(value, list):
                value = value[0] if value else None
            if value is None:
                continue
            name = str(entry.get("target_frame", "")).removeprefix(XR_FRAME_PREFIX)
            radii[name] = float(value)

        hand = str(info.get("hand") or "unknown")
        source = info.get("source_device_id")
        hand_info = HandInfo(
            device_id=device_id,
            hand=hand,
            timestamp_epoch=definition.get("timestamp_epoch"),
            source_device_id=int(source) if source is not None else None,
            joint_names=joint_names,
            joint_radii=radii,
            definition=definition,
        )
        plan = _DecodePlan(
            group_id=group_id,
            slots=list(slots),
            joint_names=joint_names,
            payload_size=payload_size,
            hand=hand,
        )
        log.info(
            "solved %s hand announced: device %d, %d joints",
            hand,
            device_id,
            len(joint_names),
        )
        with self._cond:
            self._infos[device_id] = hand_info
            self._plans[device_id] = plan
            # A re-announce (reconnect upstream, changed layout) invalidates
            # any frame decoded under the previous plan.
            self._frames.pop(device_id, None)
            self._generation += 1
            self._cond.notify_all()

    def _on_data(
        self,
        device_id: int,
        group_id: int,
        timestamp_us: int,
        payload: bytes,
        _layout: StreamLayout,
    ) -> None:
        plan = self._plans.get(device_id)
        if plan is None or group_id != plan.group_id:
            return
        if len(payload) < plan.payload_size:
            self._warn_once(
                device_id,
                "short-frame",
                f"solved hand {device_id}: joints_openxr frame is "
                f"{len(payload)} bytes, expected {plan.payload_size} — dropping",
            )
            return

        joints: list[JointPose] = []
        for name, slot in zip(plan.joint_names, plan.slots):
            v = read_slot(slot, payload)
            joints.append(JointPose(name, (v[0], v[1], v[2]), (v[3], v[4], v[5], v[6])))
        frame = HandFrame(
            device_id=device_id,
            hand=plan.hand,
            timestamp_us=timestamp_us,
            joints=tuple(joints),
        )
        with self._cond:
            self._frames[device_id] = frame
            self._generation += 1
            self._cond.notify_all()

    def _on_disconnect(self, device_id: int) -> None:
        with self._cond:
            had_info = self._infos.pop(device_id, None) is not None
            had_frame = self._frames.pop(device_id, None) is not None
            had = had_info or had_frame
            self._plans.pop(device_id, None)
            if had:
                self._generation += 1
                self._cond.notify_all()
        log.info("solved hand %d disconnected", device_id)
