"""Minimal RCSP client example.

This script is a small, end-to-end walkthrough of the Rokoko Command Server
Protocol described in the RCSP spec (/reference/rcsp on the docs site).
The goal is for the code to read in roughly the same order the spec does:

    1. Open a TCP socket to the RCSP server (default localhost:45451).
    2. Send the `ListDevices` top-level command and read the response.
    3. Send a `GetDeviceInfo` device command for the first device returned.

The wire-level pieces (header format, framing, command envelope) live in
`rcsp_client.py` so they can be reused by other examples.

Run it:

    python3 rcsp_cmd_example.py --host localhost --port 45451
"""

from __future__ import annotations

import argparse
import json
import sys

from rcsp_client import DEFAULT_PORT, RcspClient


def main(host: str, port: int) -> int:
    with RcspClient(host, port) as client:
        print(f"Connected to RCSP server at {host}:{port}\n")

        # 1. ListDevices — a top-level command, no Arguments needed.
        devices_resp = client.send_command("ListDevices")
        print("ListDevices response:")
        print(json.dumps(devices_resp, indent=2))

        devices = devices_resp.get("Devices", [])
        if not devices:
            print("\nNo devices connected — nothing more to demo.")
            return 0

        # 2. GetDeviceInfo — a device command, so it needs DeviceId in Arguments.
        device_id = devices[0]["DeviceId"]
        print(f"\nQuerying GetDeviceInfo for DeviceId={device_id}...")
        info = client.send_command("GetDeviceInfo", {"DeviceId": device_id})
        print("GetDeviceInfo response:")
        print(json.dumps(info, indent=2))

    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Minimal RCSP client example.")
    parser.add_argument(
        "--host", default="localhost", help="RCSP server host (default: localhost)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"RCSP server port (default: {DEFAULT_PORT})",
    )
    args = parser.parse_args()

    sys.exit(main(args.host, args.port))
