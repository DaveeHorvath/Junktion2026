"""RGMP v2 wire-format primitives: the data-type grammar, stream-slot
decoding, and the per-device decoding plan built from a Stream Definition.

`StreamSlot`, `ParsedDataType`, and `StreamLayout` live here together, as
they do in the Rust and TypeScript ports.
"""

from __future__ import annotations

import re
import struct
from dataclasses import dataclass, field
from typing import Any

_BASE_TYPES: dict[str, tuple[str, int]] = {
    "INT32": ("i", 4),
    "UINT32": ("I", 4),
    "INT64": ("q", 8),
    "UINT64": ("Q", 8),
    "FLOAT": ("f", 4),
    "DOUBLE": ("d", 8),
}

_DATA_TYPE_RE = re.compile(
    r"^(INT32|UINT32|INT64|UINT64|FLOAT|DOUBLE)(?:\[(\d+)(?:,\s*(\d+))?\])?$"
)


def parse_data_type(raw: str) -> tuple[str, int, int]:
    m = _DATA_TYPE_RE.match(raw.strip())
    if not m:
        raise ValueError(f"Unknown data_type: {raw!r}")
    base = m.group(1)
    cols = int(m.group(2)) if m.group(2) else 1
    rows = int(m.group(3)) if m.group(3) else 1
    if cols == 0 or rows == 0:
        raise ValueError(f"data_type {raw!r} has a zero dimension")
    count = rows * cols
    return base, count, _BASE_TYPES[base][1] * count


def unpack_values(
    base_type: str, count: int, buf: bytes, offset: int = 0
) -> tuple[Any, ...]:
    """Unpack `count` values of `base_type` from `buf` starting at `offset`."""
    fmt = "<" + _BASE_TYPES[base_type][0] * count
    return struct.unpack_from(fmt, buf, offset)


@dataclass
class StreamSlot:
    """One stream's byte offset and shape within a group's packed payload."""

    offset: int
    base_type: str
    count: int
    byte_size: int = 0
    entry: dict[str, Any] | None = None


def read_slot(slot: StreamSlot, payload: bytes) -> tuple[Any, ...]:
    return unpack_values(slot.base_type, slot.count, payload, slot.offset)


def stream_label(entry: dict[str, Any]) -> str:
    """How a stream is named in messages: its `custom_label`, else its
    `target_frame`, else a placeholder."""
    return str(entry.get("custom_label") or entry.get("target_frame") or "?")


# ── Stream layout ────────────────────────────────────────────────────────────


@dataclass
class StreamLayout:
    """Pre-computed decoding plan for a single device's stream definition."""

    definition: dict[str, Any]
    groups: dict[int, list[StreamSlot]] = field(default_factory=dict)
    group_names: dict[int, str] = field(default_factory=dict)

    @classmethod
    def from_definition(cls, definition: dict[str, Any]) -> "StreamLayout":
        """Build the decoding plan. Raises `ValueError` naming the group and
        stream when a `data_type` is missing or not one this module knows;
        every stream after it in the group would sit at an unknown offset."""
        layout = cls(definition=definition)
        groups = definition.get("groups") or []
        if not isinstance(groups, list):
            raise ValueError("groups is not a list")
        for gid, group in enumerate(groups):
            if not isinstance(group, dict):
                raise ValueError(f"group {gid} is not an object")
            name = group.get("name", "")
            streams = group.get("streams") or []
            if not isinstance(streams, list):
                raise ValueError(f"group {gid} ({name}): streams is not a list")
            slots: list[StreamSlot] = []
            offset = 0
            for entry in streams:
                if not isinstance(entry, dict):
                    raise ValueError(f"group {gid} ({name}): stream is not an object")
                try:
                    base, count, size = parse_data_type(str(entry["data_type"]))
                except KeyError:
                    raise ValueError(
                        f"group {gid} ({name}) stream {stream_label(entry)}: no data_type"
                    ) from None
                except ValueError as e:
                    raise ValueError(
                        f"group {gid} ({name}) stream {stream_label(entry)}: {e}"
                    ) from e
                slots.append(StreamSlot(offset, base, count, size, entry))
                offset += size
            layout.groups[gid] = slots
            layout.group_names[gid] = name
        return layout
