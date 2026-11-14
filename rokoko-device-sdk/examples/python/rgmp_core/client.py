"""The RGMP v2 connect-and-dispatch loop.

Named `client` rather than `reader` because it owns its socket. Callers
assign callbacks rather than matching on returned events.

Data frames are dispatched with their `StreamLayout` rather than decoded here:
only the caller knows which of a session's devices it cares about.
"""

from __future__ import annotations

import json
import socket
import struct
from collections.abc import Callable
from typing import Any

from rgmp_core.definition import parse_definition
from rgmp_core.frame import (
    DATA_INNER_HEADER_SIZE,
    FrameType,
    ProtocolError,
    read_frame,
)
from rgmp_core.layout import StreamLayout

DEFAULT_PORT = 12276


# ── Client ────────────────────────────────────────────────────────────────────


DefinitionCallback = Callable[[dict[str, Any], StreamLayout], None]
DataCallback = Callable[[int, int, int, bytes, StreamLayout], None]
DisconnectCallback = Callable[[int], None]
ErrorCallback = Callable[[Exception], None]
UnknownCallback = Callable[[int, bytes], None]
UndecodableCallback = Callable[[dict[str, Any], ValueError], None]


class RgmpClient:
    """RGMP v2 TCP client with multi-device support.

    Definition frames build per-device `StreamLayout`s that are then used to
    decode subsequent data frames for the same device.

    Example usage::

        with RgmpClient(host, port) as client:
            client.on_definition = lambda d, layout: print(d["device_id"])
            client.on_data = lambda dev, gid, ts, payload, layout: ...
            client.run()
    """

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = DEFAULT_PORT,
        timeout: float | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout
        self._sock: socket.socket | None = None
        self._has_connected = False
        self._layouts: dict[int, StreamLayout] = {}

        # Per-frame callbacks. Assign these before calling `run()`.
        self.on_definition: DefinitionCallback | None = None
        self.on_data: DataCallback | None = None
        self.on_disconnect: DisconnectCallback | None = None
        self.on_error: ErrorCallback | None = None
        # Non-fatal: msg_len said how far to skip, so we stay in sync.
        self.on_unknown: UnknownCallback | None = None
        # Non-fatal: a well-formed definition whose streams this client has no
        # decoding for. The device is skipped and its data frames dropped; the
        # rest of the session is unaffected.
        self.on_undecodable: UndecodableCallback | None = None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def __enter__(self) -> "RgmpClient":
        self._sock = socket.create_connection(
            (self.host, self.port), timeout=self.timeout
        )
        self._sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self._has_connected = True
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def close(self) -> None:
        """Drop the socket, unblocking a `run()` parked in `recv`. Safe from
        another thread and more than once."""
        sock, self._sock = self._sock, None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()

    # ── Socket helpers ────────────────────────────────────────────────────────

    @property
    def _socket(self) -> socket.socket:
        if self._sock is None:
            if self._has_connected:
                # close() ran from another thread, between reads. Reported
                # like a peer close, which run() already treats as clean.
                raise ConnectionError("RgmpClient was closed")
            raise RuntimeError(
                "RgmpClient is not connected; use it as a context manager."
            )
        return self._sock

    def _recv_exact(self, n: int) -> bytes:
        buf = bytearray()
        while len(buf) < n:
            chunk = self._socket.recv(n - len(buf))
            if not chunk:
                if buf:
                    raise ProtocolError(
                        f"connection closed mid-read ({len(buf)} of {n} bytes)"
                    )
                raise ConnectionError("Server closed the connection")
            buf.extend(chunk)
        return bytes(buf)

    # ── Main loop ─────────────────────────────────────────────────────────────

    def run(self) -> None:
        """Read frames forever, dispatching to callbacks until the peer closes.

        A clean close just returns. A protocol error goes to `on_error` and
        ends the loop — the connection can no longer be trusted. An unknown
        frame type goes to `on_unknown`, and a device whose streams cannot be
        laid out goes to `on_undecodable`; the loop continues past both.
        """
        try:
            while True:
                msg_prefix, payload = read_frame(self._recv_exact)

                if msg_prefix == FrameType.DEFINITION:
                    self._dispatch_definition(payload)
                elif msg_prefix == FrameType.DATA:
                    self._dispatch_data(payload)
                elif msg_prefix == FrameType.DISCONNECT:
                    self._dispatch_disconnect(payload)
                elif self.on_unknown is not None:
                    self.on_unknown(msg_prefix, payload)

        except ConnectionError:
            # Clean peer close — not an error worth surfacing.
            return
        except (ProtocolError, OSError) as e:
            if self.on_error is not None:
                self.on_error(e)

    # ── Dispatch ──────────────────────────────────────────────────────────────

    def _dispatch_definition(self, payload: bytes) -> None:
        # The envelope is the protocol's: not JSON, not an object, or no
        # integer device_id means the stream cannot be trusted.
        try:
            raw = json.loads(payload.decode("utf-8"))
            if not isinstance(raw, dict):
                raise ValueError("not a JSON object")
            definition = parse_definition(raw)
        except (UnicodeDecodeError, ValueError) as e:
            raise ProtocolError(f"malformed stream definition: {e}") from e
        device_id = definition["device_id"]

        # The streams are the device's: one we cannot lay out is skipped, the
        # way a consumer skips a device type it does not care about. Data
        # frames for it are dropped until it announces again.
        try:
            layout = StreamLayout.from_definition(definition)
        except ValueError as e:
            self._layouts.pop(device_id, None)
            if self.on_undecodable is not None:
                self.on_undecodable(definition, e)
            return

        self._layouts[device_id] = layout
        if self.on_definition is not None:
            self.on_definition(definition, layout)

    def _dispatch_data(self, payload: bytes) -> None:
        if len(payload) < DATA_INNER_HEADER_SIZE:
            raise ProtocolError(
                f"data frame payload too short: {len(payload)} bytes "
                f"(expected at least {DATA_INNER_HEADER_SIZE})"
            )
        device_id, group_id, ts_us = struct.unpack_from("<IIQ", payload, 0)
        layout = self._layouts.get(device_id)
        if layout is None:
            # The spec disallows this, but be defensive.
            return
        if self.on_data is not None:
            self.on_data(
                device_id, group_id, ts_us, payload[DATA_INNER_HEADER_SIZE:], layout
            )

    def _dispatch_disconnect(self, payload: bytes) -> None:
        if len(payload) < 4:
            raise ProtocolError(
                f"disconnect frame payload too short: {len(payload)} bytes (expected 4)"
            )
        (device_id,) = struct.unpack_from("<I", payload, 0)
        self._layouts.pop(device_id, None)
        if self.on_disconnect is not None:
            self.on_disconnect(device_id)
