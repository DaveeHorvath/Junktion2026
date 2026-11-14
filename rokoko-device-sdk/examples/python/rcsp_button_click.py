"""Minimal RCSP ButtonPushed example.

This script is a small, self-contained walkthrough of subscribing to a
device event from the Rokoko Command Server Protocol (see /reference/rcsp
on the docs site).

`ButtonPushed` is a *device-specific* publisher, so unlike the non-device
`Subscribe` command it is subscribed via `DeviceSubscribe`, which requires
a `DeviceId`. The flow is:

    1. Open a TCP socket to the RCSP server (default localhost:45451).
    2. If --device-id is not given, run `ListDevices` and pick the first one.
    3. `DeviceSubscribe` to the `DeviceEvents` / `ButtonPushed` topic.
    4. Loop, printing each ButtonPushed event until interrupted (Ctrl-C).
    5. `DeviceUnsubscribe` on the way out.

The wire-level pieces (header format, framing, command envelope) live in
`rcsp_client.py` so they can be reused by other examples.

Run it:

    python3 rcsp_button_click.py
    python3 rcsp_button_click.py --host localhost --device-id 1
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

from rcsp_client import DEFAULT_PORT, RcspClient

# The device event we care about (device-specific publisher / topic).
DEVICE_EVENTS_PUBLISHER = "DeviceEvents"
BUTTON_PUSHED_TOPIC = "ButtonPushed"


def handle_button_event(event: dict[str, Any]) -> None:
    """Print a ButtonPushed event.

    A ButtonPushed event arrives as an `event` payload wrapping the spec's
    event object:

        { "Publisher": <str>, "Topic": <str>, "EventData": <obj> }

    For DeviceEvents/ButtonPushed the EventData is `rcsp_device_event_data`,
    whose "ButtonPushType" is one of "SinglePress", "DoublePress", "LongPress".
    """
    if event.get("Publisher") != DEVICE_EVENTS_PUBLISHER:
        return
    if event.get("Topic") != BUTTON_PUSHED_TOPIC:
        return
    data = event.get("EventData", {}) or {}
    push_type = data.get("ButtonPushType", "<unknown>")
    device_id = data.get("DeviceId")
    print(f"Button pushed on DeviceId={device_id}: {push_type}")


def main(host: str, port: int, device_id: int | None) -> int:
    with RcspClient(host, port) as client:
        print(f"Connected to RCSP server at {host}:{port}\n")

        if device_id is None:
            devices_resp = client.send_command("ListDevices")
            devices = devices_resp.get("Devices", [])
            if not devices:
                print("No devices connected — nothing to subscribe to.")
                return 0
            device_id = devices[0]["DeviceId"]
            print(f"Using first device: DeviceId={device_id}")

        # ButtonPushed is a device-specific publisher, so we use DeviceSubscribe
        # and pass the DeviceId alongside the publisher/topic list.
        subscription = {
            "DeviceId": device_id,
            "Publishers": [
                {"Publisher": DEVICE_EVENTS_PUBLISHER, "Topics": [BUTTON_PUSHED_TOPIC]}
            ],
        }
        client.send_command("DeviceSubscribe", subscription)
        print(f"Subscribed to {DEVICE_EVENTS_PUBLISHER}/{BUTTON_PUSHED_TOPIC}.")
        print("Press the device button to see events. Ctrl-C to stop.\n")

        # Events arrive unsolicited from now on. `listen` blocks reading them
        # (with no socket timeout) and hands each one to our handler.
        try:
            client.listen(handle_button_event)
        except KeyboardInterrupt:
            print("\nStopping...")
        finally:
            try:
                client.send_command("DeviceUnsubscribe", subscription)
            except Exception as e:
                print(f"DeviceUnsubscribe failed (ignored): {e}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Minimal RCSP ButtonPushed example.")
    parser.add_argument("--host", default="localhost",
                        help="RCSP server host (default: localhost)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"RCSP server port (default: {DEFAULT_PORT})")
    parser.add_argument("--device-id", type=int, default=None,
                        help="DeviceId to subscribe to (default: first device returned by ListDevices)")
    args = parser.parse_args()

    sys.exit(main(args.host, args.port, args.device_id))
