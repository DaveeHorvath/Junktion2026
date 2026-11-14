"""Solve Smartgloves sensor data into hand poses and re-emit them as RGMP v2,
so any RGMP client can read solved hands without implementing the solver.

A drop-in for `rkk-hand-solver` in the compare pipeline, and it runs the Rokoko
SDK driver itself unless --no-driver is given:

    rkk-ws-bridge --rgmp-only                      # primary pipeline
    python3 rgmp_hand_solver.py                    # this, in place of rkk-hand-solver
    rkk-ws-bridge --rgmp-only \\
        --rgmp-addr 127.0.0.1:12277 --rgmp-listen 127.0.0.1:8140
"""

from __future__ import annotations

import argparse
import sys

from hand_solver import DEFAULT_LISTEN, DEFAULT_RGMP_ADDR, Config, Emit, run
from hand_solver.driver import DEFAULT_STARTUP_TIMEOUT, DriverConfig

NAME = "rgmp_hand_solver.py"


def _emit_type(text: str) -> Emit:
    """`type=Emit.parse` would work, but argparse discards a plain
    ValueError's message and substitutes its own generic "invalid ... value"
    text; ArgumentTypeError is the one exception type whose message argparse
    shows verbatim, so this is what actually gets Emit.parse's message in
    front of the user."""
    try:
        return Emit.parse(text)
    except ValueError as e:
        raise argparse.ArgumentTypeError(str(e)) from e


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=NAME,
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--listen",
        default=DEFAULT_LISTEN,
        metavar="HOST:PORT",
        help="address to serve the solved RGMP v2 stream on (default: %(default)s, "
        "matching rkk-hand-solver's own default)",
    )
    parser.add_argument(
        "--rgmp-addr",
        default=DEFAULT_RGMP_ADDR,
        metavar="HOST:PORT",
        help="the driver's RGMP v2 endpoint to read sensors from "
        "(default: %(default)s, matching rkk-hand-solver's own default)",
    )
    parser.add_argument(
        "--emit",
        type=_emit_type,
        default=Emit.LOCAL,
        metavar="local|world|both",
        help="what each solved hand carries: local joint rotations plus the rest "
        "pose (local), world-space joint transforms (world), or both groups "
        "(default: local)",
    )
    parser.add_argument(
        "--hand-width",
        type=float,
        default=0.0,
        metavar="METERS",
        help="knuckle span, widens the rest-pose finger fan (0 = model default)",
    )
    parser.add_argument(
        "--no-hinges",
        action="store_true",
        help="disable the hinge constraint (let non-thumb fingers splay/twist "
        "off-axis too)",
    )

    driver = parser.add_argument_group("driver")
    driver.add_argument(
        "--no-driver",
        action="store_true",
        help="assume the driver is already running instead of starting one",
    )
    driver.add_argument(
        "--driver-path",
        metavar="PATH",
        help="driver executable to run; overrides RKK_DRIVER_OVERRIDE",
    )
    driver.add_argument(
        "--driver-arg",
        action="append",
        default=[],
        metavar="ARG",
        help="extra argument for the driver, after the defaults; repeatable",
    )
    driver.add_argument(
        "--driver-quiet",
        action="store_true",
        help="discard the driver's output instead of letting it share ours",
    )
    driver.add_argument(
        "--driver-timeout",
        type=float,
        default=None,  # None means "not passed"; conflicts_with --no-driver
        # needs to tell that apart from the default below.
        metavar="SECONDS",
        help="how long to wait for the driver to open its RGMP v2 port "
        f"(default: {DEFAULT_STARTUP_TIMEOUT})",
    )
    return parser


def config_from_args(argv: list[str] | None = None) -> Config:
    parser = _parser()
    args = parser.parse_args(argv)

    # Rejected rather than ignored: silently dropping them hides a mistake.
    if args.no_driver:
        for flag, value in (
            ("--driver-path", args.driver_path),
            ("--driver-arg", args.driver_arg or None),
            ("--driver-quiet", args.driver_quiet or None),
            ("--driver-timeout", args.driver_timeout),
        ):
            if value:
                parser.error(f"{flag} cannot be used with --no-driver")

    return Config(
        listen=args.listen,
        rgmp_addr=args.rgmp_addr,
        emit=args.emit,
        hand_width=args.hand_width,
        hinges=not args.no_hinges,
        driver=DriverConfig(
            external=args.no_driver,
            path=args.driver_path,
            extra_args=args.driver_arg,
            quiet=args.driver_quiet,
            startup_timeout=args.driver_timeout
            if args.driver_timeout is not None
            else DEFAULT_STARTUP_TIMEOUT,
        ),
    )


def main(argv: list[str] | None = None) -> int:
    return run(config_from_args(argv), NAME)


if __name__ == "__main__":
    sys.exit(main())
