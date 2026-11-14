"""RGMP v2 outer framing, in both directions.

Every message is an 8-byte outer header (frame type + payload length)
followed by the payload:

    1  Stream Definition  -- one UTF-8 JSON blob per connected device
    2  Data               -- 16-byte inner header + tightly packed values
    3  Device Disconnect  -- device_id (4 bytes)

All integers are little-endian; see the RGMP spec (/reference/rgmp on the
docs site).
The Definition payload shape lives in `rgmp_core.definition`.
"""

from __future__ import annotations

import enum
import json
import struct
from collections.abc import Callable

from rgmp_core.definition import StreamDefinition

OUTER_HEADER_SIZE = 8  # msg_prefix (u32) + msg_len (u32)
DATA_INNER_HEADER_SIZE = 16  # device_id (u32) + group_id (u32) + ts_us (u64)
MAX_PAYLOAD = 8 * 1024 * 1024


class ProtocolError(Exception):
    """A frame that parsed structurally but can't be trusted -- a truncated
    inner header or a malformed definition"""


class FrameType(enum.IntEnum):
    """`msg_prefix` values from the RGMP v2 outer header."""

    DEFINITION = 1
    DATA = 2
    DISCONNECT = 3


# ── Writing ──────────────────────────────────────────────────────────────────


def pack_outer_header(frame_type: FrameType | int, payload: bytes) -> bytes:
    return struct.pack("<II", frame_type, len(payload)) + payload


def pack_stream_definition(definition: StreamDefinition) -> bytes:
    """A Stream Definition Frame: `msg_prefix=1`, UTF-8 JSON payload."""
    payload = json.dumps(definition).encode("utf-8")
    return pack_outer_header(FrameType.DEFINITION, payload)


def pack_data_frame(
    device_id: int, group_id: int, timestamp_us: int, stream_payload: bytes
) -> bytes:
    """A Data Frame: `msg_prefix=2`, inner header + stream values in the
    group's definition order (no padding)."""
    payload = struct.pack("<IIQ", device_id, group_id, timestamp_us) + stream_payload
    return pack_outer_header(FrameType.DATA, payload)


def pack_disconnect(device_id: int) -> bytes:
    return pack_outer_header(FrameType.DISCONNECT, struct.pack("<I", device_id))


def pack_transform(
    position: tuple[float, float, float], rotation: tuple[float, float, float, float]
) -> bytes:
    """One `TRANSFORM` / `FLOAT[7]` stream value: position (x,y,z) then
    rotation (x,y,z,w)."""
    return struct.pack("<7f", *position, *rotation)


def pack_quat(rotation: tuple[float, float, float, float]) -> bytes:
    """One `ORIENTATION` / `FLOAT[4]` stream value: rotation (x,y,z,w)."""
    return struct.pack("<4f", *rotation)


# ── Reading ──────────────────────────────────────────────────────────────────


def read_frame(recv_exact: Callable[[int], bytes]) -> tuple[int, bytes]:
    """Read one frame via `recv_exact(n)` (blocks for exactly `n` bytes, or
    raises -- e.g. a socket helper). 

    Returns the raw `msg_prefix` -- compare it against `FrameType`because an unrecognized prefix is not an
    error: the header's `msg_len` already said how far to skip."""
    
    header = recv_exact(OUTER_HEADER_SIZE)
    msg_prefix, msg_len = struct.unpack("<II", header)
    if msg_len > MAX_PAYLOAD:
        raise ProtocolError(
            f"RGMP payload size {msg_len} exceeds limit of {MAX_PAYLOAD} bytes"
        )
    payload = recv_exact(msg_len) if msg_len else b""
    return msg_prefix, payload
