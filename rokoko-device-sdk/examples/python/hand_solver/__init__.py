"""Smartgloves sensor data in, solved hands out as RGMP v2.

The composition root: `emit` -> `pipeline` -> `hub` -> `server`, with `driver`
supervising `rokoko-sdk`. The accept loop is a thread and the pump owns the
main one, so Ctrl-C lands on it.
"""

from __future__ import annotations

import sys
import threading
from dataclasses import dataclass, field

from hand_solver import driver as driver_module
from hand_solver.driver import Driver, DriverConfig, DriverError
from hand_solver.emit import Emit
from hand_solver.hub import Hub
from hand_solver.server import RgmpServer
from hand_solver.upstream import Upstream

__all__ = ["Config", "Emit", "Upstream", "parse_addr", "run", "serve"]

DEFAULT_LISTEN = "127.0.0.1:12277"
DEFAULT_RGMP_ADDR = "127.0.0.1:12276"


def _log(message: str) -> None:
    print(f"hand_solver: {message}", file=sys.stderr)


def parse_addr(value: str) -> tuple[str, int]:
    """`host:port` -> `(host, port)`, defaulting the host to loopback."""
    host, _, port = value.rpartition(":")
    if not port.isdigit():
        raise ValueError(f"expected host:port, got {value!r}")
    return host or "127.0.0.1", int(port)


@dataclass
class Config:
    listen: str = DEFAULT_LISTEN
    rgmp_addr: str = DEFAULT_RGMP_ADDR
    emit: Emit = Emit.LOCAL
    hand_width: float = 0.0  # knuckle span in meters; 0 = model default
    hinges: bool = True
    driver: DriverConfig = field(default_factory=DriverConfig)


def run(config: Config, name: str = "rgmp_hand_solver.py") -> int:
    """Run until the driver exits, the listener fails, or Ctrl-C. Returns an
    exit code."""
    return serve(config, name)


def serve(config: Config, name: str = "rgmp_hand_solver.py") -> int:
    try:
        listen_host, listen_port = parse_addr(config.listen)
        rgmp_host, rgmp_port = parse_addr(config.rgmp_addr)
    except ValueError as e:
        _log(f"{name}: {e}")
        return 2

    hub = Hub()
    server = RgmpServer(hub, listen_host, listen_port)

    # Before the driver, so a port clash fails without leaving a process.
    try:
        bound_host, bound_port = server.bind()
    except OSError as e:
        _log(f"{name}: {e}")
        return 1

    driver: Driver | None = None
    upstream = Upstream(hub, rgmp_host, rgmp_port, config)
    exit_code = 0
    try:
        try:
            driver = driver_module.spawn(config.driver, log=_log)
            if driver is not None:
                driver_module.wait_for_port(
                    rgmp_host, rgmp_port, config.driver.startup_timeout
                )
        except DriverError as e:
            _log(f"{name}: {e}")
            return 1

        # After the driver is up, so the line means "ready to serve", and
        # with the resolved address so a :0 request shows its real port.
        _log(
            f"{name} serving solved hands on rgmp://{bound_host}:{bound_port} "
            f"<- RGMP {rgmp_host}:{rgmp_port} (emit: {config.emit})"
        )

        threading.Thread(
            target=server.serve_forever, name="accept-loop", daemon=True
        ).start()

        # A driver we own exiting ends the process.
        exit_reason = _ExitReason()
        if driver is not None:
            threading.Thread(
                target=_watch_driver,
                args=(driver, upstream, exit_reason),
                name="driver-watchdog",
                daemon=True,
            ).start()

        try:
            upstream.pump()
        except KeyboardInterrupt:
            _log(f"{name}: interrupted, shutting down")

        if exit_reason.message is not None:
            _log(f"{name}: {exit_reason.message}; there is nothing left to solve")
            exit_code = 1
        return exit_code
    finally:
        upstream.stop()
        server.close()
        if driver is not None:
            driver.kill()


@dataclass
class _ExitReason:
    message: str | None = None


def _watch_driver(driver: Driver, upstream: Upstream, reason: _ExitReason) -> None:
    reason.message = driver.wait()
    upstream.stop()  # wakes the pump, which is what returns from serve()
