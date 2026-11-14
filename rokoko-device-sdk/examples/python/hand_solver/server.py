"""The output port: the listener and the accept loop, nothing else."""

from __future__ import annotations

import socket
import sys
import threading
import time

from hand_solver.hub import Hub, serve_consumer

DEFAULT_LISTEN_PORT = 12277

# Backoff between accept() retries, so a persistent failure doesn't spin.
_ACCEPT_RETRY_DELAY = 0.1
_SEND_TIMEOUT = 5.0


def _log(message: str) -> None:
    print(f"hand_solver: {message}", file=sys.stderr)


class RgmpServer:
    """Accepts consumers and feeds each one from `hub`."""

    def __init__(
        self, hub: Hub, host: str = "127.0.0.1", port: int = DEFAULT_LISTEN_PORT
    ) -> None:
        self.hub = hub
        self.host = host
        self.port = port
        self._sock: socket.socket | None = None
        self._threads: list[threading.Thread] = []
        self._closed = threading.Event()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def bind(self) -> tuple[str, int]:
        """Bind and listen, returning the address actually bound."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((self.host, self.port))
            sock.listen()
        except OSError as e:
            sock.close()
            raise OSError(
                f"cannot bind the solved RGMP endpoint to {self.host}:{self.port}: {e}"
            ) from e
        self._sock = sock
        self.host, self.port = sock.getsockname()
        return self.host, self.port

    def serve_forever(self) -> None:
        """Accept connections until `close()`, one thread per consumer."""
        if self._sock is None:
            self.bind()
        assert self._sock is not None

        while not self._closed.is_set():
            # Snapshotted: close() can null self._sock between the guard
            # above and accept() below, and None.accept() isn't an OSError.
            sock = self._sock
            if sock is None:
                return
            try:
                conn, peer = sock.accept()
            except OSError as e:
                if self._closed.is_set():
                    return
                # EMFILE/ENFILE and the like: report and back off, not spin.
                _log(f"accept failed: {e}")
                time.sleep(_ACCEPT_RETRY_DELAY)
                continue
            self._start_consumer(conn, peer)

    def close(self) -> None:
        """Stop accepting and wake every consumer thread."""
        self._closed.set()
        if self._sock is not None:
            # shutdown() unblocks a thread parked in accept(); close() alone
            # does not, reliably.
            try:
                self._sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self._sock.close()
            self._sock = None
        self.hub.close()

    def join_consumers(self, timeout: float | None = None) -> None:
        for thread in list(self._threads):
            thread.join(timeout)

    # ── One consumer ──────────────────────────────────────────────────────────

    def _start_consumer(self, conn: socket.socket, peer) -> None:
        # Pruned here if dead
        self._threads = [t for t in self._threads if t.is_alive()]
        thread = threading.Thread(
            target=self._serve_consumer, args=(conn, peer), daemon=True
        )
        self._threads.append(thread)
        thread.start()

    def _serve_consumer(self, conn: socket.socket, peer) -> None:
        _log(f"consumer connected: {peer}")
        try:
            # Small payloads at ~83 Hz; Nagle would add latency.
            try:
                conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError as e:
                _log(f"cannot disable Nagle for {peer}: {e}")
            conn.settimeout(_SEND_TIMEOUT)
            with conn:
                serve_consumer(conn.sendall, self.hub)
        finally:
            _log(f"consumer disconnected: {peer}")
