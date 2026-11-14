"""Shared RCSP client helpers.

This module implements the wire-level pieces of the Rokoko Command Server
Protocol (see /reference/rcsp on the docs site) so that example scripts can
focus on the commands they want to demonstrate rather than on framing bytes.

Every message on the wire is an 8-byte binary header followed by a JSON
payload. Commands are sent client → server and elicit exactly one response;
events may interleave with responses and are skipped by `send_command`.
"""

from __future__ import annotations

import enum
import itertools
import json
import socket
from typing import Any, Callable


_UNSET: Any = object()  # Sentinel: "no override" (distinct from `None`, which means "no timeout").


DEFAULT_PORT = 45451  # The server listens here.

# ── Protocol constants ────────────────────────────────────────────────────────
# These mirror the `struct header` definition in the "Message structure"
# section of the RCSP spec.

HEADER_MARKER = 0xDC  # Sentinel byte ("DeviceCommands"); every header starts with it.
HEADER_VERSION = 1  # Binary header format version.
HEADER_SIZE = 8  # Total bytes in the header.

# ── Binary header ─────────────────────────────────────────────────────────────
# Layout (all little-endian):
#     marker         : uint8   (always 0xDC)
#     header_version : uint8   (currently 1)
#     header_size    : uint8   (== 8)
#     type           : uint8   (PayloadType)
#     payload_size   : uint32  (length of the JSON body that follows)


class PayloadType(enum.IntEnum):
    """The four payload kinds the protocol carries (the header's `type` field)."""

    COMMAND = 1  # client → server  (always elicits exactly one response)
    RESPONSE_OK = 2  # server → client
    RESPONSE_ERROR = 3  # server → client
    EVENT = 4  # server → client  (pub/sub; may interleave with responses)


def build_header(payload_type: PayloadType, payload_size: int) -> bytes:
    return bytes(
        [HEADER_MARKER, HEADER_VERSION, HEADER_SIZE, int(payload_type)]
    ) + payload_size.to_bytes(4, byteorder="little")


def parse_header(header: bytes) -> tuple[PayloadType, int]:
    if len(header) != HEADER_SIZE:
        raise RuntimeError(
            f"Short header: got {len(header)} bytes, expected {HEADER_SIZE}"
        )
    if header[0] != HEADER_MARKER:
        raise RuntimeError(
            f"Bad marker: 0x{header[0]:02x} (expected 0x{HEADER_MARKER:02x})"
        )
    return PayloadType(header[3]), int.from_bytes(header[4:8], byteorder="little")


class RcspConnection:
    """A connected RCSP message stream. Use as a context manager."""

    def __init__(
        self, host: str, port: int = DEFAULT_PORT, timeout: float = 5.0
    ) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout
        self._sock: socket.socket | None = None

    def __enter__(self) -> "RcspConnection":
        self._sock = socket.create_connection(
            (self.host, self.port), timeout=self.timeout
        )
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._sock is not None:
            self._sock.close()
            self._sock = None

    @property
    def _socket(self) -> socket.socket:
        if self._sock is None:
            raise RuntimeError(
                "RcspConnection is not connected; use it as a context manager."
            )
        return self._sock

    def _recv_exact(self, n: int) -> bytes:
        """Read exactly `n` bytes from the socket."""
        buf = bytearray()
        while len(buf) < n:
            chunk = self._socket.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("Server closed the connection mid-message")
            buf.extend(chunk)
        return bytes(buf)

    def send(self, payload_type: PayloadType, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode()
        self._socket.sendall(build_header(payload_type, len(body)) + body)

    def recv(self) -> tuple[PayloadType, dict[str, Any]]:
        # TCP is a raw byte stream — it has no message boundaries of its own. The
        # connection reads the fixed-size header first, then uses `payload_size` to read
        # exactly one JSON message body.
        payload_type, payload_size = parse_header(self._recv_exact(HEADER_SIZE))
        payload = json.loads(self._recv_exact(payload_size).decode())
        return payload_type, payload


class RcspClient:
    """A connected RCSP client. Use as a context manager.

    Per the spec, every command MUST get exactly one response (ok or error), and
    responses arrive in the same order commands were sent. Events MAY arrive
    between a command and its response, so `send_command` skips them while
    waiting for the reply.

    `RcspClient` opens an `RcspConnection` internally and exposes command-oriented methods.

    Example usage:
        with RcspClient(host, port) as client:
            devices = client.send_command("ListDevices")
    """

    def __init__(
        self, host: str, port: int = DEFAULT_PORT, timeout: float = 5.0
    ) -> None:
        self._connection = RcspConnection(host, port, timeout)
        self._track_ids = itertools.count(1)

    def __enter__(self) -> "RcspClient":
        self._connection.__enter__()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self._connection.__exit__(exc_type, exc, tb)

    def _wrap_command(
        self, name: str, arguments: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Wrap a command name and arguments in the standard envelope.

        Every command is wrapped in the `rcsp_cmd` object from the spec:

             { "Command": <str>, "TrackId": <str>, "Version": <num>, "Arguments": <opt obj> }

        The server echoes `TrackId` in the matching response so a client can pair
        requests with replies. `RcspClient` uses a monotonically increasing counter.
        """

        cmd: dict[str, Any] = {
            "Command": name,
            "TrackId": str(next(self._track_ids)),
            "Version": 1,
        }
        if arguments is not None:
            cmd["Arguments"] = arguments
        return cmd

    def send_command(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        on_event: Callable[[dict[str, Any]], None] | None = None,
        timeout: float | None = _UNSET,
    ) -> dict[str, Any]:
        """Send a command and return the server's `Response` object.

        Events that arrive between this command and its response are passed to
        `on_event` (and otherwise silently dropped). This matters for
        long-running commands like `UpdateFirmware`, which only return their
        final `Ok` after the work is done while emitting progress events in the
        meantime.

        `timeout` (seconds) temporarily overrides the socket timeout for this
        call: pass `None` to block indefinitely (appropriate when the command
        itself can legitimately take minutes). When omitted, the connection's
        existing timeout is used.

        Raises RuntimeError on a `response_error` payload.
        """
        command_envelope = self._wrap_command(name, arguments)
        self._connection.send(PayloadType.COMMAND, command_envelope)

        sock = self._connection._socket
        prior_timeout = sock.gettimeout() if timeout is not _UNSET else None
        if timeout is not _UNSET:
            sock.settimeout(timeout)
        try:
            while True:
                ptype, payload = self._connection.recv()
                if ptype == PayloadType.EVENT:
                    if on_event is not None:
                        on_event(payload)
                    continue
                if ptype == PayloadType.RESPONSE_ERROR:
                    err = payload.get("Error", {})
                    raise RuntimeError(
                        f"{name} failed: {err.get('Code')}: {err.get('Message')}"
                    )
                if ptype == PayloadType.RESPONSE_OK:
                    # An "Ok with no data" response may omit "Response" entirely.
                    return payload.get("Response", {})
                raise RuntimeError(f"Unexpected payload type from server: {ptype!r}")
        finally:
            if timeout is not _UNSET:
                sock.settimeout(prior_timeout)

    def listen(
        self,
        on_event: Callable[[dict[str, Any]], None],
        timeout: float | None = None,
    ) -> None:
        """Block reading incoming messages, dispatching each event to `on_event`.

        Intended for pub/sub examples that subscribe and then sit waiting for
        unsolicited events (unlike `send_command`, which only forwards events
        that arrive while waiting for a reply). `timeout` (seconds) overrides
        the socket timeout for the duration of the loop; the default `None`
        blocks indefinitely. Stray response payloads are ignored.

        Loops until the connection closes or the caller interrupts it; the
        socket timeout is restored on the way out so callers can keep using the
        client (e.g. to unsubscribe).
        """
        sock = self._connection._socket
        prior_timeout = sock.gettimeout()
        sock.settimeout(timeout)
        try:
            while True:
                ptype, payload = self._connection.recv()
                if ptype == PayloadType.EVENT:
                    on_event(payload)
        finally:
            sock.settimeout(prior_timeout)
