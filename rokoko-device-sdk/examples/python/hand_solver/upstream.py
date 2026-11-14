"""Reads the driver's RGMP v2 stream, solves it, and publishes the result."""

from __future__ import annotations

import sys
import threading
from typing import TYPE_CHECKING

from hand_solver.hub import Hub
from hand_solver.pipeline import Pipeline
from rgmp_core.client import RgmpClient

if TYPE_CHECKING:
    from hand_solver import Config

_BACKOFF_START = 0.25
_BACKOFF_MAX = 5.0


def _log(message: str) -> None:
    print(f"hand_solver: {message}", file=sys.stderr)


class Upstream:
    """Reconnects with backoff for as long as the process lives.

    The pipeline outlives each connection: a reconnect re-announces whatever
    devices are there, and `clear()` tells consumers the old ones are gone.
    """

    def __init__(self, hub: Hub, host: str, port: int, config: Config) -> None:
        self.hub = hub
        self.host = host
        self.port = port
        self.pipeline = Pipeline(config.emit, config.hand_width, config.hinges)
        self._stopped = threading.Event()
        self._lock = threading.Lock()
        self._client: RgmpClient | None = None

    def stop(self) -> None:
        """Unblock a session parked in `recv`. Safe from any thread."""
        self._stopped.set()
        with self._lock:
            client = self._client
        if client is not None:
            client.close()

    def pump(self) -> None:
        backoff = _BACKOFF_START
        announced_failure = False

        while not self._stopped.is_set():
            try:
                client = RgmpClient(self.host, self.port)
                with client:
                    with self._lock:
                        if self._stopped.is_set():
                            return
                        self._client = client
                    _log(f"reading RGMP v2 from {self.host}:{self.port}")
                    backoff = _BACKOFF_START
                    announced_failure = False
                    if self.read_session(client):
                        _log("RGMP stream closed")
            except (ConnectionError, OSError) as e:
                # First failure of a run only, or a retry loop fills the log.
                if not announced_failure:
                    announced_failure = True
                    _log(
                        f"cannot reach the RGMP v2 server at {self.host}:{self.port}: "
                        f"{e}; retrying"
                    )
            finally:
                with self._lock:
                    self._client = None
                # Those devices are gone; a reconnect re-announces them.
                for device_id, frame in self.pipeline.clear():
                    self.hub.publish_disconnect(device_id, frame)

            if self._stopped.wait(backoff):  # interruptible by stop()
                return
            backoff = min(backoff * 2, _BACKOFF_MAX)

    def read_session(self, client: RgmpClient) -> bool:
        """Pump one connection until it ends. Returns whether it ended
        cleanly: `client.run()` also returns normally after routing a
        ProtocolError to `on_error`, and the caller's own 'RGMP stream
        closed' would otherwise follow right behind that error, implying
        nothing was wrong."""
        had_error = False

        def on_definition(definition, _layout) -> None:
            frame = self.pipeline.on_definition(definition)
            if frame is not None:
                self.hub.publish_definition(int(definition["device_id"]), frame)

        def on_data(device_id, group_id, timestamp_us, values, _layout) -> None:
            for frame in self.pipeline.on_data(
                device_id, group_id, timestamp_us, values
            ):
                self.hub.publish_data(frame)

        def on_disconnect(device_id) -> None:
            frame = self.pipeline.on_disconnect(device_id)
            if frame is not None:
                self.hub.publish_disconnect(device_id, frame)

        def on_unknown(msg_prefix, _payload) -> None:
            # Non-fatal: msg_len told us how far to skip, so we stay in sync.
            _log(f"ignoring unknown RGMP frame type {msg_prefix}")

        def on_undecodable(definition, error) -> None:
            # Non-fatal: some other device on the stream; the gloves are
            # unaffected.
            _log(
                f"device {definition['device_id']}: cannot decode its streams "
                f"({error}); ignoring it"
            )

        def on_error(e: Exception) -> None:
            nonlocal had_error
            had_error = True
            _log(f"RGMP stream error: {e}")

        client.on_definition = on_definition
        client.on_data = on_data
        client.on_disconnect = on_disconnect
        client.on_unknown = on_unknown
        client.on_undecodable = on_undecodable
        client.on_error = on_error

        client.run()
        return not had_error
