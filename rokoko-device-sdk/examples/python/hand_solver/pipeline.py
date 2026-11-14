# RGMP events in, framed solved-hand messages out. No I/O.

from __future__ import annotations

import sys
from dataclasses import dataclass, field

from hand_solver.emit import Emit, HandEmitter
from rgmp_core.definition import StreamDefinition
from rgmp_core.frame import pack_disconnect, pack_stream_definition
from solver_core.finger_poser import (
    GloveState,
    glove_state_from_sample,
    is_finite_pose,
    solve_fingers,
)
from solver_core.skeleton import HandSkeleton
from solver_core.smartglove import (
    GloveDecodeError,
    GloveSample,
    SensorSlots,
    decode_glove_sample,
    detect_is_right,
    find_glove_layout,
    is_smartglove,
)

DEFAULT_RATE_HZ = 83.3
# A degenerate frame (a zero-length vector to normalize, say) raises
# ZeroDivisionError, an ArithmeticError. ValueError has no motivated path
# here -- every math.acos() call site in the solver clamps its argument to
# [-1, 1] first -- so it is not caught: a bug that raises one should surface,
# not be silently treated as "just a bad frame".
_SOLVE_FAILURES = (ArithmeticError,)


def _log(message: str) -> None:
    print(f"hand_solver: {message}", file=sys.stderr)


@dataclass
class _GloveRig:
    sensor_group_id: int
    slots: dict[int, SensorSlots]
    is_right: bool
    skeleton: HandSkeleton
    emitter: HandEmitter
    # Framed once, shared with every consumer including later ones.
    definition: bytes
    # Warn once: a bad frame repeats at ~83 Hz.
    warned_decode: bool = field(default=False)
    warned_non_finite: bool = field(default=False)
    warned_solve_failed: bool = field(default=False)
    warned_out_of_range: bool = field(default=False)

    @property
    def side(self) -> str:
        return "right" if self.is_right else "left"


class Pipeline:
    """Turns one RGMP session's events into solved-hand frames."""

    def __init__(
        self, emit: Emit = Emit.LOCAL, hand_width: float = 0.0, hinges: bool = True
    ) -> None:
        self.emit = emit
        self.hand_width = hand_width
        self.hinges = hinges
        self._rigs: dict[int, _GloveRig] = {}

    # ── Events in ─────────────────────────────────────────────────────────────

    def on_definition(self, definition: StreamDefinition) -> bytes | None:
        """The framed solved-hand definition, or None if this isn't a glove we
        can solve."""
        device_id = int(definition["device_id"])
        if not is_smartglove(definition):
            return None

        try:
            found = find_glove_layout(definition)
        except GloveDecodeError as e:
            _log(f"device {device_id}: cannot decode this glove's streams: {e}")
            return None
        if found is None:
            _log(f"device {device_id}: no decodable sensor streams; ignoring")
            return None
        sensor_group_id, slots = found

        groups = definition.get("groups") or []
        rate = DEFAULT_RATE_HZ
        if sensor_group_id < len(groups):
            rate = groups[sensor_group_id].get("expected_rate_hz") or DEFAULT_RATE_HZ

        is_right = detect_is_right(definition)
        skeleton = HandSkeleton("right" if is_right else "left")
        emitter = HandEmitter(definition, skeleton, self.emit, rate)
        framed = pack_stream_definition(emitter.definition)

        _log(
            f"solving {'right' if is_right else 'left'} hand from device "
            f"{device_id} (group {sensor_group_id}, {len(slots)} sensors, {rate} Hz)"
        )

        # A reused device_id is a new session, so the rig is replaced.
        self._rigs[device_id] = _GloveRig(
            sensor_group_id=sensor_group_id,
            slots=slots,
            is_right=is_right,
            skeleton=skeleton,
            emitter=emitter,
            definition=framed,
        )
        return framed

    def on_data(
        self, device_id: int, group_id: int, timestamp_us: int, values: bytes
    ) -> list[bytes]:
        """The frames to publish for one data frame. Unknown devices and a
        glove's other groups are ignored."""
        rig = self._rigs.get(device_id)
        if rig is None or group_id != rig.sensor_group_id:
            return []

        sample = self._try_decode(rig, device_id, values)
        if sample is None:
            return []

        state = glove_state_from_sample(sample, rig.is_right, self.hand_width)
        if not self._try_solve(rig, device_id, state):
            return []

        if not is_finite_pose(rig.skeleton):
            self._warn_non_finite_pose(rig, device_id)
            return []

        return self._try_encode(rig, device_id, timestamp_us)

    # ── on_data steps (each warns once per rig; a bad frame repeats at the stream rate)

    def _try_decode(
        self, rig: _GloveRig, device_id: int, values: bytes
    ) -> GloveSample | None:
        try:
            return decode_glove_sample(values, rig.slots)
        except GloveDecodeError as e:
            if not rig.warned_decode:
                rig.warned_decode = True
                _log(
                    f"device {device_id}: {e} (warning once; later frames are "
                    "dropped silently)"
                )
            return None

    def _try_solve(self, rig: _GloveRig, device_id: int, state: GloveState) -> bool:
        try:
            solve_fingers(state, rig.skeleton, self.hinges)
            return True
        except _SOLVE_FAILURES as e:
            if not rig.warned_solve_failed:
                rig.warned_solve_failed = True
                _log(
                    f"device {device_id}: solve failed on a degenerate frame "
                    f"({type(e).__name__}: {e}); dropping those frames (warning once)"
                )
            return False

    def _warn_non_finite_pose(self, rig: _GloveRig, device_id: int) -> None:
        if rig.warned_non_finite:
            return
        rig.warned_non_finite = True
        _log(
            f"device {device_id}: solve produced non-finite joints; "
            "dropping those frames (warning once)"
        )

    def _try_encode(
        self, rig: _GloveRig, device_id: int, timestamp_us: int
    ) -> list[bytes]:
        try:
            return rig.emitter.encode(rig.skeleton, timestamp_us)
        except OverflowError:
            if not rig.warned_out_of_range:
                rig.warned_out_of_range = True
                _log(
                    f"device {device_id}: solve produced joints too large for "
                    "FLOAT on the wire; dropping those frames (warning once)"
                )
            return []

    def on_disconnect(self, device_id: int) -> bytes | None:
        """The framed disconnect to publish, if we were solving that device."""
        rig = self._rigs.pop(device_id, None)
        if rig is None:
            return None
        _log(f"device {device_id} disconnected ({rig.side} hand)")
        return pack_disconnect(device_id)

    # ── State out ─────────────────────────────────────────────────────────────

    def clear(self) -> list[tuple[int, bytes]]:
        """Drop every glove, returning `(device_id, disconnect frame)` pairs.

        For when the upstream connection ends: those devices are gone as far
        as consumers are concerned, and a reconnect re-announces them.
        """
        ids = sorted(self._rigs)  # stable order for tests and logs
        self._rigs.clear()
        return [(device_id, pack_disconnect(device_id)) for device_id in ids]

    def definitions(self) -> list[tuple[int, bytes]]:
        """Every current definition — what a consumer joining mid-session needs
        before any data frame means anything."""
        return [
            (device_id, self._rigs[device_id].definition)
            for device_id in sorted(self._rigs)
        ]

    def glove_count(self) -> int:
        return len(self._rigs)
