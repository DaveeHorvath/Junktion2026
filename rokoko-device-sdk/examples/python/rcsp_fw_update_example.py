"""Minimal RCSP firmware-update example.

This script walks through an `UpdateFirmware` flow end-to-end, as
described in the RCSP spec (/reference/rcsp on the docs site):

    1. Open a TCP socket to the RCSP server (default localhost:45451).
    2. (If no --device-id given) `ListDevices` and pick the first one.
    3. `Subscribe` to the `UpdateFwEvents` publisher.
    4. Send `UpdateFirmware` — this returns Ok immediately; progress is
       reported through events.
    5. Read events until we see `Done` or `Failure`.
    6. `Unsubscribe`.

Note that `FwPath` is resolved by the *server*. When the server runs on
the same machine as this script, an absolute local path works; otherwise
the file must exist at the given path on the server.

Run it:

    python3 rcsp_fw_update_example.py --host localhost path/to/firmware.bin
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any

from rcsp_client import DEFAULT_PORT, RcspClient

UPDATE_FW_PUBLISHER = "UpdateFwEvents"
UPDATE_FW_TOPICS = ["Progress", "Failure", "Done"]


def _pick_device_id(client: RcspClient) -> int | None:
    devices_resp = client.send_command("ListDevices")
    devices = devices_resp.get("Devices", [])
    if not devices:
        print("No devices connected — nothing to update.")
        return None
    device_id = devices[0]["DeviceId"]
    print(f"Using first device: DeviceId={device_id}")
    return device_id


def main(host: str, port: int, device_id: int | None, fw_path: pathlib.Path) -> int:
    fw_path = fw_path.resolve()
    if not fw_path.is_file():
        print(f"Firmware file not found: {fw_path}", file=sys.stderr)
        return 1

    with RcspClient(host, port) as client:
        print(f"Connected to RCSP server at {host}:{port}\n")

        if device_id is None:
            device_id = _pick_device_id(client)
            if device_id is None:
                return 0

        # Subscribe to UpdateFwEvents so we can follow progress.
        subscription = {
            "Publishers": [
                {"Publisher": UPDATE_FW_PUBLISHER, "Topics": UPDATE_FW_TOPICS}
            ]
        }
        client.send_command("Subscribe", subscription)

        # The server returns Ok only after the entire update completes, while
        # streaming Progress/Done/Failure events along the way. We pass an
        # on_event callback so we can show progress live, and disable the
        # socket timeout because firmware updates can take minutes.
        exit_code = 0
        outcome: dict[str, Any] = {}

        def on_event(event: dict[str, Any]) -> None:
            if event.get("Publisher") != UPDATE_FW_PUBLISHER:
                return
            topic = event.get("Topic")
            data = event.get("EventData", {}) or {}
            if topic == "Progress":
                pct = data.get("PercentComplete")
                bar = f"{pct:>3}%" if pct is not None else "  ?"
                print(f"\rProgress: {bar}", end="", flush=True)
            elif topic == "Done":
                outcome["topic"] = "Done"
            elif topic == "Failure":
                outcome["topic"] = "Failure"
                outcome["error"] = data.get("ErrorMsg")

        try:
            print(f"Sending UpdateFirmware for DeviceId={device_id}, FwPath={fw_path}")
            ok = client.send_command(
                "UpdateFirmware",
                {
                    "DeviceId": device_id,
                    "FwPath": str(fw_path),
                    "ForceUpdate": False,
                    "SensorsInBoot": False,
                },
                on_event=on_event,
                timeout=None,
            )
            print(f"\nUpdateFirmware accepted: {json.dumps(ok)}")

            if outcome.get("topic") == "Failure":
                print(
                    f"Firmware update failed: {outcome.get('error')}",
                    file=sys.stderr,
                )
                exit_code = 2
            else:
                print("Firmware update complete. Please power-cycle the device.")
            return exit_code
        finally:
            try:
                client.send_command("Unsubscribe", subscription)
            except Exception as e:
                print(f"Unsubscribe failed (ignored): {e}", file=sys.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Minimal RCSP firmware-update example."
    )
    parser.add_argument(
        "--host", default="localhost", help="RCSP server host (default: localhost)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"RCSP server port (default: {DEFAULT_PORT})",
    )
    parser.add_argument(
        "--device-id",
        type=int,
        default=None,
        help="DeviceId to update (default: first device returned by ListDevices)",
    )
    parser.add_argument(
        "firmware_path",
        type=pathlib.Path,
        help="Path to the firmware file (resolved server-side)",
    )
    args = parser.parse_args()

    sys.exit(main(args.host, args.port, args.device_id, args.firmware_path))
