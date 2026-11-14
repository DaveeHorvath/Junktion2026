"""Get or set network configuration on a Rokoko device.

This script connects to a running driver and either reads the current Wi-Fi
configuration from a USB-connected Rokoko device (`get`) or pushes a new one
to it (`set`).

Normally this would be done from the _Rokoko Studio_ application, but this
script can be used to automate the process or to provision devices without
using the full application.

Run it:

    # Read the current configuration
    python3 network_configuration.py get

    # Push a new configuration
    python3 network_configuration.py set \\
        --ssid MyWifiNetwork \\
        --receiver-address 192.168.1.100 \\
        --receiver-port 14041

Common options (before the subcommand):
  `--rcsp-host`
    the hostname or IP address of the machine running the Rokoko driver
    (default is 'localhost').
  `--rcsp-port`
    the port number on which the Rokoko driver is running (default is 45451).

`get` options:
  `--raw`
    print the full JSON response instead of the compact summary.

`set` options:
  `--ssid`
    the name of the Wifi network you want to connect to. The program will ask
    for the password unless `--security Open` is given.
  `--receiver-address`
    the IP address of the device you want to send the data to (e.g., your
    computer's IP address). Pass 'auto' to have the script detect this
    machine's outbound IP (typically the Wi-Fi IP).
  `--receiver-port`
    the port number on which the receiver device is listening for incoming data.
  `--security`
    security type: Open, WPA2 (default), or WPA3_Personal. Choosing Open
    skips the password prompt.
"""

from __future__ import annotations

import argparse
import getpass
import json
import random
import socket
import sys

from rcsp_client import DEFAULT_PORT, RcspClient


def _detect_local_ip() -> str:
    # Open a UDP socket and "connect" to a routable address. No packets are
    # actually sent; the OS just picks the outbound interface and binds the
    # socket to its address, which we then read back via getsockname(). This
    # is the standard stdlib-only, cross-platform way to discover the host's
    # primary IP — on a Wi-Fi-only machine this is the Wi-Fi IP.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        try:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
        except OSError as e:
            raise RuntimeError(
                f"Could not detect a local IP address ({e}). "
                "Pass --receiver-address explicitly."
            ) from e
    if ip.startswith("127."):
        raise RuntimeError(
            "Detected only a loopback address; no usable network "
            "interface appears to be up. "
            "Pass --receiver-address explicitly."
        )
    return ip


def _printable(s: str) -> dict[str, object]:
    # `RcspPrintableByteArray` per the spec — `Raw` is the UTF-8 bytes of `Str`.
    return {"Raw": list(s.encode("utf-8")), "Str": s}


def build_set_arguments(
    device_id: int,
    ssid: str,
    password: str | None,
    security: str,
    receiver_address: str,
    receiver_port: int,
) -> dict[str, object]:
    settings = {
        "HubAddr": random.randint(0, 0xFFFF),
        "DhcpMode": 1,  # 1 = DHCP
        "ChannelNo": 0,  # 0 = auto
        "SecurityType": security,
        "ServerIp": receiver_address,
        "ServerPort": receiver_port,
        "DeviceIp": "0.0.0.0",  # unused under DHCP
        "Gateway": "0.0.0.0",  # unused under DHCP
        "Band": 2,  # 2 = dual band
        "Ssid": _printable(ssid),
        "Psk": _printable(password if password is not None else ""),
    }
    return {"DeviceId": device_id, "Settings": settings}


_SECURITY = {
    "Open": "open",
    "WPA2": "WPA2",
    "WPA3_Personal": "WPA3 Personal",
}
_BAND = {0: "2.4 GHz", 1: "5 GHz", 2: "dual band"}


def _format_settings(settings: dict[str, object]) -> str:
    def printable(field: str) -> str:
        v = settings.get(field)
        return v.get("Str", "") if isinstance(v, dict) else ""

    def decode(table: dict, field: str) -> str:
        v = settings.get(field)
        return table.get(v, str(v))

    channel = settings.get("ChannelNo")
    dhcp = settings.get("DhcpMode") == 1
    hub = settings.get("HubAddr")

    lines = [
        f"SSID:        {printable('Ssid')} [{decode(_SECURITY, 'SecurityType')}]",
        f"Band:        {decode(_BAND, 'Band')}, channel {'auto' if channel == 0 else channel}",
        f"IP mode:     {'DHCP' if dhcp else 'static'}",
    ]
    if not dhcp:
        lines.append(f"Device IP:   {settings.get('DeviceIp')}")
        lines.append(f"Gateway:     {settings.get('Gateway')}")
    lines.append(
        f"Receiver:    {settings.get('ServerIp')}:{settings.get('ServerPort')}"
    )
    if isinstance(hub, int):
        lines.append(f"HubAddr:     0x{hub:04x}")
    return "\n".join(lines)


def do_get(client: RcspClient, device_id: int, raw: bool) -> None:
    response = client.send_command(
        "GetNetworkConfiguration", {"DeviceId": device_id}
    )
    if raw:
        print(json.dumps(response, indent=2))
        return
    settings = response.get("Settings", response)
    print("Network configuration:")
    print(_format_settings(settings))


def do_set(
    client: RcspClient,
    device_id: int,
    ssid: str,
    password: str | None,
    security: str,
    receiver_address: str,
    receiver_port: int,
) -> None:
    arguments = build_set_arguments(
        device_id, ssid, password, security, receiver_address, receiver_port
    )
    response = client.send_command("SetNetworkConfiguration", arguments)
    print("SetNetworkConfiguration response:")
    print(json.dumps(response, indent=2))


def main(args: argparse.Namespace) -> int:
    with RcspClient(args.rcsp_host, args.rcsp_port) as client:
        print(f"Connected to RCSP server at {args.rcsp_host}:{args.rcsp_port}")

        devices = client.send_command("ListDevices").get("Devices", [])
        if not devices:
            print("No devices connected — nothing to do.")
            return 1

        device_id = devices[0]["DeviceId"]
        print(f"Targeting DeviceId={device_id}")

        if args.subcommand == "get":
            do_get(client, device_id, args.raw)
        else:
            do_set(
                client,
                device_id,
                args.ssid,
                args.password,
                args.security,
                args.receiver_address,
                args.receiver_port,
            )

    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Get or set Wi-Fi network configuration on a Rokoko device."
    )
    parser.add_argument(
        "--rcsp-host",
        default="localhost",
        help="RCSP server host (default: localhost)",
    )
    parser.add_argument(
        "--rcsp-port",
        type=int,
        default=DEFAULT_PORT,
        help=f"RCSP server port (default: {DEFAULT_PORT})",
    )

    subparsers = parser.add_subparsers(dest="subcommand", required=True)
    get_parser = subparsers.add_parser(
        "get", help="Read the current network configuration from the device."
    )
    get_parser.add_argument(
        "--raw",
        action="store_true",
        help="Print the full JSON response instead of the summary.",
    )

    set_parser = subparsers.add_parser(
        "set", help="Push a new network configuration to the device."
    )
    set_parser.add_argument(
        "--ssid", required=True, help="Wi-Fi network name (SSID)."
    )
    set_parser.add_argument(
        "--receiver-address",
        required=True,
        help="IP address of the receiver. Use 'auto' to detect this "
        "machine's outbound IP (typically the Wi-Fi IP).",
    )
    set_parser.add_argument(
        "--receiver-port",
        type=int,
        required=True,
        help="UDP port the receiver is listening on.",
    )
    set_parser.add_argument(
        "--security",
        choices=("Open", "WPA2", "WPA3_Personal"),
        default="WPA2",
        help="Security type (default: WPA2). Use 'Open' for unsecured "
        "networks; the password prompt is skipped in that case.",
    )

    args = parser.parse_args(argv)

    if args.subcommand == "set":
        if args.receiver_address == "auto":
            args.receiver_address = _detect_local_ip()
            print(f"Auto-detected receiver address: {args.receiver_address}")
        args.password = (
            None
            if args.security == "Open"
            else getpass.getpass(f"Password for Wi-Fi network '{args.ssid}': ")
        )

    return args


if __name__ == "__main__":
    try:
        sys.exit(main(parse_args()))
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
