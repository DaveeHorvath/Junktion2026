"""Minimal RGMP v2 client example.

This script is a small, end-to-end walkthrough of the Rokoko General
Motion Protocol v2 described in the RGMP spec (/reference/rgmp on the
docs site). It connects to an RGMP v2 server, prints the stream
definition for each connected device, and then prints a throttled
summary of incoming data frames until Ctrl-C.

The wire-level pieces (framing, layout, frame dispatch) live in
`rgmp_core.client` so they can be reused by other examples.

Run it:

    python3 rgmp_client_example.py --host localhost --port 12276
"""

from __future__ import annotations

import argparse
import sys

from rgmp_core.layout import StreamLayout, unpack_values
from rgmp_core.client import DEFAULT_PORT, RgmpClient


def _format_values(values: tuple, max_items: int = 3) -> str:
    if all(isinstance(v, float) for v in values):
        head = ", ".join(f"{v:+.3f}" for v in values[:max_items])
    else:
        head = ", ".join(str(v) for v in values[:max_items])
    return f"[{head}{', …' if len(values) > max_items else ''}]"


def main(host: str, port: int) -> int:
    client = RgmpClient(host, port)

    # Throttle per-(device, group) data prints so a 60+ Hz stream doesn't
    # flood the terminal — print at most once per second per group.
    last_print_us: dict[tuple[int, int], int] = {}

    def on_definition(definition: dict, layout: StreamLayout) -> None:
        device_id = definition["device_id"]
        device_type = definition.get("device_type") or "<unknown>"
        print(f"Device {device_id} connected: type={device_type}")
        for gid, slots in layout.groups.items():
            name = layout.group_names[gid]
            rate = definition["groups"][gid].get("expected_rate_hz", 0)
            print(f"  group {gid} '{name}' @ {rate} Hz, {len(slots)} streams")

    def on_data(
        device_id: int,
        group_id: int,
        ts_us: int,
        payload: bytes,
        layout: StreamLayout,
    ) -> None:
        key = (device_id, group_id)
        if ts_us - last_print_us.get(key, 0) < 1_000_000:
            return
        last_print_us[key] = ts_us

        slots = layout.groups[group_id]
        streams = []
        for slot in slots:
            label = slot.entry.get("target_frame") or slot.entry.get(
                "custom_label", "?"
            )
            values = unpack_values(slot.base_type, slot.count, payload, slot.offset)
            streams.append(f"{label}={_format_values(values)}")
        print(
            f"dev={device_id} group='{layout.group_names[group_id]}' "
            f"ts={ts_us} {' '.join(streams)}"
        )

    def on_disconnect(device_id: int) -> None:
        print(f"Device {device_id} disconnected")

    def on_unknown(msg_prefix: int, payload: bytes) -> None:
        # A frame type this client doesn't know. The stream stays in sync, so
        # note it and keep reading.
        print(f"skipped unknown frame type {msg_prefix} ({len(payload)} bytes)")

    def on_undecodable(definition: dict, error: ValueError) -> None:
        # A device this client has no decoding for. Its data frames are
        # dropped; every other device keeps flowing.
        print(f"Device {definition['device_id']} skipped: {error}")

    client.on_definition = on_definition
    client.on_data = on_data
    client.on_disconnect = on_disconnect
    client.on_unknown = on_unknown
    client.on_undecodable = on_undecodable
    client.on_error = lambda e: print(f"error: {e}", file=sys.stderr)

    with client:
        print(f"Connected to RGMP server at {host}:{port}\n")
        try:
            client.run()
        except KeyboardInterrupt:
            print("\nInterrupted.")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Minimal RGMP v2 client example.")
    parser.add_argument(
        "--host", default="127.0.0.1", help="RGMP server host (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"RGMP server port (default: {DEFAULT_PORT})",
    )
    args = parser.parse_args()

    sys.exit(main(args.host, args.port))
