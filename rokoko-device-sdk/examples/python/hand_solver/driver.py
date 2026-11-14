"""Running and supervising the Rokoko SDK driver.

`Driver` is a context manager because Python has no deterministic drop to hang
kill-on-exit off.
"""

from __future__ import annotations

import os
import socket
import subprocess
import time
from dataclasses import dataclass, field

DEFAULT_DRIVER = "rokoko-sdk"
DEFAULT_DRIVER_ARGS = ("-vv", "--auto-stream-usb")

DRIVER_OVERRIDE_ENV = "RKK_DRIVER_OVERRIDE"

DEFAULT_STARTUP_TIMEOUT = 15.0
_POLL_INTERVAL = 0.25


class DriverError(Exception):
    """The driver could not be started, or never opened its port."""


@dataclass
class DriverConfig:
    external: bool = False  # the driver is already running; do not start one
    path: str | None = None  # else DRIVER_OVERRIDE_ENV, else DEFAULT_DRIVER
    extra_args: list[str] = field(default_factory=list)
    quiet: bool = False  # send the driver's output to null, not our streams
    startup_timeout: float = DEFAULT_STARTUP_TIMEOUT

    def program(self) -> str:
        """Flag, then environment, then the default."""
        return self.path or os.environ.get(DRIVER_OVERRIDE_ENV) or DEFAULT_DRIVER

    def args(self) -> list[str]:
        return [*DEFAULT_DRIVER_ARGS, *self.extra_args]


class Driver:
    """A driver process we own. Killed on exit from its `with` block."""

    def __init__(self, process: subprocess.Popen, program: str) -> None:
        self.process = process
        self.program = program

    def __enter__(self) -> "Driver":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.kill()

    def kill(self) -> None:
        """Terminate, then kill.

        The driver releases its USB devices on SIGTERM, and a device left
        claimed by a dead process needs a replug. Only the direct child is
        signalled, so forked helpers may survive.

        Never raises: a child stuck in uninterruptible I/O can ignore
        SIGKILL too, and this runs from `serve()`'s `finally`, where an
        exception would discard the computed exit code. Rust's equivalent
        (`start_kill()`) does not even wait, so giving up here matches it
        rather than blocking shutdown on a child that will not die.
        """
        if self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=2.0)
            return
        except subprocess.TimeoutExpired:
            pass
        self.process.kill()
        try:
            self.process.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            pass

    def wait(self) -> str:
        """Block until the driver exits, describing how."""
        code = self.process.wait()
        return f"{self.program} exited with code {code}"


def spawn(config: DriverConfig, log=None) -> Driver | None:
    """Start the driver, or `None` when `config.external` is set."""
    if config.external:
        return None

    program = config.program()
    args = config.args()
    if log is not None:
        log(f"starting driver: {program} {' '.join(args)}")

    # Inherited by default, so the driver's logging lands with ours — which
    # is what makes this usable in an mprocs pane.
    output = subprocess.DEVNULL if config.quiet else None
    try:
        process = subprocess.Popen(
            [program, *args],
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=output,
        )
    except OSError as e:
        raise DriverError(
            f"cannot start the driver ({program}): {e}. Is it on your PATH? "
            f"Use --driver-path, set {DRIVER_OVERRIDE_ENV}, or pass --no-driver "
            "if it is already running."
        ) from e
    return Driver(process, program)


def wait_for_port(
    host: str, port: int, timeout: float = DEFAULT_STARTUP_TIMEOUT
) -> None:
    #Wait until `host:port` accepts a connection, or `timeout` elapses.

    deadline = time.monotonic() + timeout
    last_error: OSError | None = None
    while True:
        try:
            with socket.create_connection((host, port), timeout=_POLL_INTERVAL):
                return
        except OSError as e:
            last_error = e
        if time.monotonic() + _POLL_INTERVAL >= deadline:
            raise DriverError(
                f"the driver did not open its RGMP v2 port at {host}:{port} within "
                f"{timeout}s: {last_error}. It only serves RGMP when started with "
                "`--pipeline_formatter rgmp_v2`."
            )
        time.sleep(_POLL_INTERVAL)
