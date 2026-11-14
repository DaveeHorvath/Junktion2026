"""The Stream Definition frame payload shape.

Schema: the RGMP spec (/reference/rgmp on the docs site).
"""

from __future__ import annotations

from typing import Any, TypedDict


class StreamEntry(TypedDict, total=False):
    """One stream, group member, or `static_data` entry (same shape for all three)."""

    data_type: str
    measure_type: str
    target_frame: str
    reference_frame: str
    custom_label: str
    bit_mapping: dict[str, Any]
    value: Any


class GroupEntry(TypedDict, total=False):
    """Streams transmitted together at one rate; index in `groups` is the wire `group_id`."""

    name: str
    expected_rate_hz: float
    streams: list[StreamEntry]


class _StreamDefinitionRequired(TypedDict):
    device_id: int


class StreamDefinition(_StreamDefinitionRequired, total=False):
    """One device's complete self-description."""

    protocol_name: str
    protocol_version: str
    device_type: str
    timestamp_epoch: str
    device_info: dict[str, Any]
    static_data: list[StreamEntry]
    groups: list[GroupEntry]


def parse_definition(raw: dict[str, Any]) -> StreamDefinition:
    """Check `raw` has a valid `device_id`, then return it typed. Raises `ValueError`
    otherwise -- nothing else is required or copied."""
    device_id = raw.get("device_id")
    if not isinstance(device_id, int) or isinstance(device_id, bool):
        raise ValueError(f"Stream Definition missing a valid integer device_id: {device_id!r}")
    return raw  # type: ignore[return-value]


def device_type_contains(definition: StreamDefinition, needle: str) -> bool:
    """Case-insensitive substring match, e.g. "smartglove" matches "smartgloves"."""
    return needle.lower() in str(definition.get("device_type") or "").lower()


def device_info_str(definition: StreamDefinition, key: str) -> str | None:
    info = definition.get("device_info")
    value = info.get(key) if isinstance(info, dict) else None
    return value if isinstance(value, str) else None


def device_info_bool(definition: StreamDefinition, key: str) -> bool | None:
    info = definition.get("device_info")
    value = info.get(key) if isinstance(info, dict) else None
    return value if isinstance(value, bool) else None
