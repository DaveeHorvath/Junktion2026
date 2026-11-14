"""
Each matched stream value is emitted as one delimited row on stdout as data arrives.

Status/banner lines go to stderr (prefixed with `#`), so stdout stays clean
for piping to grep/awk/cut/etc.

No external dependencies beyond the Python standard library.

Usage examples:
  python3 rgmp_stream.py --host 127.0.0.1 --port 12276
  python3 rgmp_stream.py --host 127.0.0.1 --port 12276 --measure-type POSITION
  python3 rgmp_stream.py --host 127.0.0.1 --port 12276 --separator ,
  python3 rgmp_stream.py --host 127.0.0.1 --port 12276 --sep '|'
"""

# cSpell: ignore calcsize

import argparse
import json
import re
import socket
import struct
import sys
from dataclasses import dataclass
import threading
from time import sleep
from typing import Optional

import requests
from data.classifier import Predictor

import keyboard

# -- Custom shit ----
pred = Predictor()
IsRecoding = False
targetFile = None
predictionQueue = []
isPredicting = False
latest = " "
latestCount = 0
def record():
    global IsRecoding
    IsRecoding = not IsRecoding
    print('Recording toggled to {}'.format(IsRecoding))

def openFile(key):
    targetFileName = "data/" + key + '.csv'
    global targetFile
    targetFile = open(targetFileName, 'a')
    print('opened file {}'.format(targetFileName))

def closeFile():
    global IsRecoding
    IsRecoding = False
    targetFile.close()
    print('Recording toggled to {}'.format(IsRecoding))

def togglePredict():
    global isPredicting
    isPredicting = not isPredicting
    print('Predicting toggled to {}'.format(isPredicting))

def periodicPredict():
    global latest
    global latestCount
    if latestCount >= 0:
        requests.get(f'http://192.168.1.102:8000/?text={latest}')
        latestCount = 0
    if isPredicting:
        decide()
    threading.Timer(0.01, periodicPredict).start()

def decide():
    global predictionQueue
    sleep(1)
    batch, predictionQueue = predictionQueue, []
    batch.sort(key=lambda x: x[0])

    values = [v for x in batch for v in x[1]]   # flatten 6 frames into one list
    print(','.join(str(v) for v in values))

    if len(values) != 42:
        print(f"need 42 values, got {len(values)}")
        return None

    label, confidence, top = pred.predict(values)[0]
    global latestCount
    global latest
    if label == latest:
        latestCount += 1
    else:
        latestCount = 0
    latest = label
    print(f"prediction: {label}  confidence: {confidence:.1%} top: {top}")
    return label, confidence

keyboard.add_hotkey('space', lambda: record())
keyboard.add_hotkey('1', lambda: closeFile())

keyboard.add_hotkey('7', lambda: togglePredict())

keyboard.add_hotkey('0', lambda: openFile('0'))
keyboard.add_hotkey('a', lambda: openFile('a'))
keyboard.add_hotkey('b', lambda: openFile('b'))
keyboard.add_hotkey('c', lambda: openFile('c'))
keyboard.add_hotkey('d', lambda: openFile('d'))
keyboard.add_hotkey('e', lambda: openFile('e'))
keyboard.add_hotkey('f', lambda: openFile('f'))
keyboard.add_hotkey('g', lambda: openFile('g'))
keyboard.add_hotkey('h', lambda: openFile('h'))
keyboard.add_hotkey('i', lambda: openFile('i'))
# keyboard.add_hotkey('j', lambda: openFile('j'))
keyboard.add_hotkey('k', lambda: openFile('k'))
keyboard.add_hotkey('l', lambda: openFile('l'))
keyboard.add_hotkey('m', lambda: openFile('m'))
keyboard.add_hotkey('n', lambda: openFile('n'))
keyboard.add_hotkey('o', lambda: openFile('o'))
keyboard.add_hotkey('p', lambda: openFile('p'))
keyboard.add_hotkey('q', lambda: openFile('q'))
keyboard.add_hotkey('r', lambda: openFile('r'))
keyboard.add_hotkey('s', lambda: openFile('s'))
keyboard.add_hotkey('t', lambda: openFile('t'))
keyboard.add_hotkey('u', lambda: openFile('u'))
keyboard.add_hotkey('v', lambda: openFile('v'))
keyboard.add_hotkey('w', lambda: openFile('w'))
keyboard.add_hotkey('x', lambda: openFile('x'))
keyboard.add_hotkey('y', lambda: openFile('y'))
# keyboard.add_hotkey('z', lambda: openFile('z'))
thread = threading.Thread(target=periodicPredict).start()


# ── Protocol constants ────────────────────────────────────────────────────────

MSG_PREFIX_DEFINITION = 1
MSG_PREFIX_DATA = 2
MSG_PREFIX_DISCONNECT = 3

OUTER_HEADER_FMT = "<II"
OUTER_HEADER_SIZE = struct.calcsize(OUTER_HEADER_FMT)

DATA_FRAME_HEADER_FMT = "<IIQ"
DATA_FRAME_HEADER_SIZE = struct.calcsize(DATA_FRAME_HEADER_FMT)

DISCONNECT_FMT = "<I"
DISCONNECT_SIZE = struct.calcsize(DISCONNECT_FMT)


# ── Data-type parsing ─────────────────────────────────────────────────────────

_BASE_TYPES: dict[str, tuple[str, int]] = {
    name: (fmt, struct.calcsize(fmt))
    for name, fmt in {
        "INT32": "i",
        "UINT32": "I",
        "INT64": "q",
        "UINT64": "Q",
        "FLOAT": "f",
        "DOUBLE": "d",
    }.items()
}

_DATA_TYPE_RE = re.compile(
    r"^(INT32|UINT32|INT64|UINT64|FLOAT|DOUBLE)"
    r"(?:\[(\d+)(?:,\s*(\d+))?\])?$"
)


def parse_data_type(data_type: str) -> tuple[str, int]:
    m = _DATA_TYPE_RE.match(data_type.strip())
    if not m:
        raise ValueError(f"Unrecognized data_type: {data_type!r}")

    fmt_char, base_bytes = _BASE_TYPES[m.group(1)]
    n = int(m.group(2)) if m.group(2) else 1
    rows = int(m.group(3)) if m.group(3) else 1
    count = n * rows

    return f"<{count}{fmt_char}", base_bytes * count


# ── Stream descriptor ─────────────────────────────────────────────────────────


@dataclass(slots=True)
class StreamDescriptor:
    offset: int
    struct_fmt: str
    byte_size: int
    data_type: str
    target_frame: str
    measure_type: str
    reference_frame: str
    custom_label: str


# ── Filter matching ───────────────────────────────────────────────────────────


def _stream_matches(
    stream: dict,
    group_name: str,
    group_name_filter: Optional[str],
    measure_type_filter: Optional[str],
    target_frame_filter: Optional[str],
) -> bool:
    if group_name_filter and group_name != group_name_filter:
        return False
    if measure_type_filter and stream.get("measure_type") != measure_type_filter:
        return False
    if target_frame_filter and stream.get("target_frame") != target_frame_filter:
        return False
    return True


# ── Byte-offset pre-calculation ───────────────────────────────────────────────


def build_group_lookup(
    definition: dict,
    group_name_filter: Optional[str],
    measure_type_filter: Optional[str],
    target_frame_filter: Optional[str],
) -> dict[int, list[StreamDescriptor]]:
    lookup: dict[int, list[StreamDescriptor]] = {}

    for group_id, group in enumerate(definition.get("groups", [])):
        group_name = group.get("name", f"group_{group_id}")
        descriptors: list[StreamDescriptor] = []
        current_offset = 0

        for stream in group.get("streams", []):
            struct_fmt, byte_size = parse_data_type(stream["data_type"])

            if _stream_matches(
                stream,
                group_name,
                group_name_filter,
                measure_type_filter,
                target_frame_filter,
            ):
                descriptors.append(
                    StreamDescriptor(
                        offset=current_offset,
                        struct_fmt=struct_fmt,
                        byte_size=byte_size,
                        data_type=stream["data_type"],
                        target_frame=stream.get("target_frame", ""),
                        measure_type=stream.get("measure_type", ""),
                        reference_frame=stream.get("reference_frame", ""),
                        custom_label=stream.get("custom_label", ""),
                    )
                )

            current_offset += byte_size

        if descriptors:
            lookup[group_id] = descriptors

    return lookup


# ── Robust socket reader ──────────────────────────────────────────────────────


def recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = bytearray(n)
    view = memoryview(buf)
    received = 0
    while received < n:
        bytes_read = sock.recv_into(view[received:], n - received)
        if bytes_read == 0:
            raise ConnectionError("Server closed the connection")
        received += bytes_read
    return bytes(buf)


# ── Output formatting ─────────────────────────────────────────────────────────

COLUMNS = (
    "timestamp_us",
    "group",
    "target_frame",
    "reference_frame",
    "measure_type",
    "custom_label",
    "data_type",
    "values",
)


def _format_value(v) -> str:
    # repr preserves float round-trip; int falls back to plain decimal.
    return repr(v) if isinstance(v, float) else str(v)


def emit_row(sep: str, fields: tuple[str, ...]) -> None:
    if (fields[0] == 'default' and fields[2] == 'hub'
            and fields[3] == 'TRANSFORM' and len(predictionQueue) < 6):
        inner = ';' if sep == ',' else ','
        predictionQueue.append([fields[1], [float(x) for x in fields[6].split(inner)]])
    if IsRecoding and targetFile:
        targetFile.write(sep.join(fields) + "\n")


def log(msg: str) -> None:
    sys.stderr.write(f"# {msg}\n")
    sys.stderr.flush()


# ── CLI ───────────────────────────────────────────────────────────────────────


def _decode_separator(raw: str) -> str:
    try:
        decoded = bytes(raw, "utf-8").decode("unicode_escape")
    except UnicodeDecodeError as exc:
        raise argparse.ArgumentTypeError(f"invalid separator escape: {exc}") from exc
    if not decoded:
        raise argparse.ArgumentTypeError("separator must be non-empty")
    return decoded


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Pipe-friendly RGMP v2 streaming console client.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--host",
        default="127.0.0.1",
        metavar="HOST",
        help="Server hostname or IP (default: 127.0.0.1)",
    )
    p.add_argument(
        "--port",
        default=12276,
        metavar="PORT",
        type=int,
        help="Server port (default: 12276)",
    )
    p.add_argument(
        "--group-name",
        default=None,
        metavar="NAME",
        help="Only show streams from this group (exact match)",
    )
    p.add_argument(
        "--measure-type",
        default=None,
        metavar="TYPE",
        help="Only show streams with this measure_type "
        "(e.g. POSITION, TRANSFORM, ORIENTATION)",
    )
    p.add_argument(
        "--target-frame",
        default=None,
        metavar="FRAME",
        help="Only show streams for this target_frame (e.g. pelvis)",
    )
    p.add_argument(
        "--separator",
        "--sep",
        default="\t",
        metavar="SEP",
        type=_decode_separator,
        dest="separator",
        help="Column separator. Accepts escapes like '\\t', ',', '|' (default: TAB)",
    )
    return p


# ── Main ──────────────────────────────────────────────────────────────────────


def main() -> None:
    args = build_arg_parser().parse_args()

    sep = args.separator
    # The values field packs multiple numbers — keep its inner separator
    # distinct from the column separator so the column stays single-field.
    inner_sep = ";" if sep == "," else ","

    active_filters = {
        k: v
        for k, v in {
            "group-name": args.group_name,
            "measure-type": args.measure_type,
            "target-frame": args.target_frame,
        }.items()
        if v
    }
    log(f"RGMP v2 streaming client → {args.host}:{args.port}")
    log(
        "filters: "
        + (
            "none (showing all streams)"
            if not active_filters
            else "  ".join(f"{k}={v}" for k, v in active_filters.items())
        )
    )

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.connect((args.host, args.port))
    except OSError as exc:
        log(f"could not connect: {exc}")
        sys.exit(1)
    log("connected")

    group_lookup: dict[int, list[StreamDescriptor]] = {}
    group_names: dict[int, str] = {}
    definition_received = False
    header_emitted = False

    try:
        while True:
            outer = recv_exact(sock, OUTER_HEADER_SIZE)
            msg_prefix, msg_len = struct.unpack(OUTER_HEADER_FMT, outer)
            payload = recv_exact(sock, msg_len)

            if msg_prefix == MSG_PREFIX_DEFINITION:
                definition = json.loads(payload.decode("utf-8"))
                group_lookup = build_group_lookup(
                    definition,
                    args.group_name,
                    args.measure_type,
                    args.target_frame,
                )
                group_names = {
                    i: g.get("name", f"group_{i}")
                    for i, g in enumerate(definition.get("groups", []))
                }
                definition_received = True

                watched = sum(len(v) for v in group_lookup.values())
                dev_id = definition.get("device_id", "?")
                log(
                    f"definition: device_id={dev_id}  groups={len(group_names)}  "
                    f"watching {watched} stream(s) across {len(group_lookup)} group(s)"
                )

                if not header_emitted:
                    sys.stdout.write("#" + sep.join(COLUMNS) + "\n")
                    sys.stdout.flush()
                    header_emitted = True

            elif msg_prefix == MSG_PREFIX_DATA:
                if not definition_received:
                    continue
                if len(payload) < DATA_FRAME_HEADER_SIZE:
                    continue

                _dev_id, group_id, timestamp_us = struct.unpack_from(
                    DATA_FRAME_HEADER_FMT, payload, 0
                )

                if group_id not in group_lookup:
                    continue

                stream_payload = memoryview(payload)[DATA_FRAME_HEADER_SIZE:]
                group_name = group_names.get(group_id, f"group_{group_id}")

                for desc in group_lookup[group_id]:
                    values = struct.unpack_from(
                        desc.struct_fmt, stream_payload, desc.offset
                    )
                    values_field = inner_sep.join(_format_value(v) for v in values)
                    emit_row(
                        sep,
                        (
                            # str(timestamp_us),
                            group_name,
                            desc.target_frame,
                            desc.reference_frame,
                            desc.measure_type,
                            desc.custom_label,
                            desc.data_type,
                            values_field,
                        ),
                    )

            elif msg_prefix == MSG_PREFIX_DISCONNECT:
                disconnected_id: Optional[int] = None
                if len(payload) >= DISCONNECT_SIZE:
                    (disconnected_id,) = struct.unpack_from(DISCONNECT_FMT, payload, 0)
                log(
                    f"device {disconnected_id} disconnected"
                    if disconnected_id is not None
                    else "device disconnected (no device_id in payload)"
                )

            else:
                # Unknown frame type — ignore per spec extensibility rules.
                pass

    except KeyboardInterrupt:
        log("interrupted by user")
    except ConnectionError as exc:
        log(f"connection lost: {exc}")
    except Exception as exc:  # noqa: BLE001
        log(f"unexpected error: {exc}")
        raise
    finally:
        sock.close()
        log("socket closed")
        thread.kill()


if __name__ == "__main__":
    main()
