"""Minimal RCSP SetColorLed example.

This script is a small, self-contained walkthrough of the `SetColorLed`
device command from the Rokoko Command Server Protocol (see /reference/rcsp
on the docs site).

    1. Open a TCP socket to the RCSP server (default localhost:45451).
    2. If --device-id is not given, run `ListDevices` and pick the first one.
    3. Send `SetColorLed` with {DeviceId, LedId, Red, Green, Blue}.

The wire-level pieces (header format, framing, command envelope) live in
`rcsp_client.py` so they can be reused by other examples.

Run it:

    python3 rcsp_set_color_led_example.py 255 0 0          # red on first device
    python3 rcsp_set_color_led_example.py --device-id 1 0 255 0
"""

from __future__ import annotations

import argparse
import sys

from rcsp_client import DEFAULT_PORT, RcspClient


def _color_component(value: str) -> int:
    n = int(value)
    if not 0 <= n <= 255:
        raise argparse.ArgumentTypeError(f"color component must be 0..255, got {n}")
    return n


def main(host: str, port: int, device_id: int | None,
         led_id: str, red: int, green: int, blue: int) -> int:
    with RcspClient(host, port) as client:
        print(f"Connected to RCSP server at {host}:{port}\n")

        if device_id is None:
            devices_resp = client.send_command("ListDevices")
            devices = devices_resp.get("Devices", [])
            if not devices:
                print("No devices connected — nothing to do.")
                return 0
            device_id = devices[0]["DeviceId"]
            print(f"Using first device: DeviceId={device_id}")

        print(f"Setting {led_id} on DeviceId={device_id} to RGB=({red}, {green}, {blue})")
        client.send_command("SetColorLed", {
            "DeviceId": device_id,
            "LedId": led_id,
            "Red": red,
            "Green": green,
            "Blue": blue,
        })
        print("Ok.")

    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Minimal RCSP SetColorLed example.")
    parser.add_argument("--host", default="localhost",
                        help="RCSP server host (default: localhost)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"RCSP server port (default: {DEFAULT_PORT})")
    parser.add_argument("--device-id", type=int, default=None,
                        help="DeviceId to target (default: first device returned by ListDevices)")
    parser.add_argument("--led-id", default="RingLed",
                        help="LedId to set (default: RingLed)")
    parser.add_argument("red", type=_color_component, help="Red component (0..255)")
    parser.add_argument("green", type=_color_component, help="Green component (0..255)")
    parser.add_argument("blue", type=_color_component, help="Blue component (0..255)")
    args = parser.parse_args()

    sys.exit(main(args.host, args.port, args.device_id,
                  args.led_id, args.red, args.green, args.blue))
