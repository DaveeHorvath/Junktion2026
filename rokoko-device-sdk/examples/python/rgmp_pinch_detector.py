#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.24", "scipy>=1.10"]
# ///
"""Recognise the four thumb pinches from Rokoko Smartgloves and print each one.

    python3 rgmp_pinch_detector.py          # NumPy and SciPy already installed
    uv run rgmp_pinch_detector.py           # or let uv fetch them

Needs the Rokoko SDK driver, publishing RGMP v2, which is its default:

    rokoko-sdk --auto-stream-usb

Output is one line per event, a `fired` when the fingers meet and a `released`
when they part, sharing a count so the pair can be matched. The lanes on the right
are every pinch on both hands, so a held one draws a column as the lines stack up:

    Pinch  left  thumb_index   fired     #2     ...I|....
    Pinch  right thumb_ring    fired     #1     ...I|..R.
    Pinch  left  thumb_index   released  #2     ....|..R.

What a consumer does with a pinch is the consumer's business, so this prints and
stops there. The detection itself lives in `pinch_detection/`, which has a README.

Unlike its neighbours this example needs NumPy and SciPy — the shape of a hand is
linear algebra, and SciPy's Rotation does every quaternion in it.
"""

from __future__ import annotations

import argparse
import sys

from pinch_detection.engine import FIRED, PinchEngine
from pinch_detection.poses import DEFAULT_ORIENTATIONS, PINCHES
from pinch_detection.source import DEFAULT_PORT, stream

NAME = "rgmp_pinch_detector.py"

# One lane per pinch, both hands, drawn at the end of every line. A lane holds the
# finger's initial while its pinch is held and a dot when it is not, so a held pinch
# draws a column down the terminal and two hands read as two tracks.
#
# The left hand runs outward-in and the right inward-out, mirroring a pair of hands
# held palms-down in front of you, with the two thumbs meeting at the divider.
_LANE_MARK = {"thumb_index": "I", "thumb_middle": "M", "thumb_ring": "R",
              "thumb_pinky": "P"}
_LANES = (("left", tuple(reversed(PINCHES))), ("right", PINCHES))

# ASCII on purpose: this goes to a Windows console and through pipes, where a
# non-ASCII character is liable to arrive as a replacement glyph.
_IDLE = "."
_DIVIDER = "|"


def _lanes(held: set[tuple[str, str]]) -> str:
    """The eight lanes, given the pinches currently held."""
    return _DIVIDER.join(
        "".join(_LANE_MARK[p] if (hand, p) in held else _IDLE for p in order)
        for hand, order in _LANES
    )


LANE_LEGEND = (
    f"lanes  {_lanes(set())}  left hand {_DIVIDER} right hand, pinky to index"
    " outward from the thumbs; a letter is that pinch being held"
)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog=NAME, description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="127.0.0.1", help="driver host")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT,
                    help=f"driver RGMP port (default {DEFAULT_PORT})")
    ap.add_argument("--threshold-scale", type=float, default=1.0,
                    help="scale all four collision thresholds together; above 1 is "
                         "stricter, below 1 looser. The shipped numbers were measured "
                         "on one wearer's hands, so reach for this first if pinches "
                         "under- or over-fire")
    ap.add_argument("--orientations", default=",".join(DEFAULT_ORIENTATIONS),
                    help="hand attitudes a pinch is accepted in, comma separated, "
                         "or 'any'")
    ap.add_argument("--verbose", action="store_true",
                    help="also print the sensor clock of each event")
    args = ap.parse_args(argv)

    orientations: tuple[str, ...] = ()
    if args.orientations.strip().lower() != "any":
        orientations = tuple(o.strip() for o in args.orientations.split(",") if o.strip())

    engine = PinchEngine(
        threshold_scale=args.threshold_scale,
        orientations=orientations,
    )

    held: set[tuple[str, str]] = set()
    seen = 0

    def report(frame) -> None:
        nonlocal seen
        for e in engine.update(frame):
            # Every fired is closed by exactly one released, so a set tracks
            # what is held without any bookkeeping of its own.
            if e.phase == FIRED:
                held.add((e.hand, e.pinch))
            else:
                held.discard((e.hand, e.pinch))

            # Everything ahead of the lanes is fixed-width, including the
            # count, or they would step sideways as it gains a digit and stop
            # reading as columns. Anything variable goes after them.
            line = (f"Pinch  {e.hand:<5} {e.pinch:<13} {e.phase:<9}"
                    f" #{e.count:<5} {_lanes(held)}")
            if args.verbose:
                line += f"  sensor {e.t_us}us"
            print(line, flush=True)
            seen += 1

    def ignored(definition) -> None:
        # Said out loud rather than passed over: a glove whose firmware omits
        # device_type lands here too, and a silent skip would read as a dead
        # stream rather than as the wrong device.
        kind = definition.get("device_type") or "no device_type"
        print(f"ignoring device {definition.get('device_id')} ({kind}):"
              " not a Smartglove", file=sys.stderr)

    refused: list[int] = []

    def refuse(definition, why) -> None:
        # A glove that cannot be read is the one thing here worth shouting
        # about: the session carries on without it, so this is the only moment
        # anyone is told, and the fix is always something the operator does.
        refused.append(definition.get("device_id"))
        print(f"\n{'!' * 72}\nREFUSING glove {definition.get('device_id')}\n\n"
              f"{why}\n{'!' * 72}\n", file=sys.stderr, flush=True)

    print(f"reading {args.host}:{args.port} - Ctrl-C to stop", file=sys.stderr)
    print(LANE_LEGEND, file=sys.stderr)

    try:
        stream(args.host, args.port, report, ignored, refuse)
    except KeyboardInterrupt:
        pass
    except ConnectionError as exc:
        print(f"\n{exc}", file=sys.stderr)
        print("is the driver running, with --auto-stream-usb for USB gloves?",
              file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"\ncould not connect to {args.host}:{args.port}: {exc}", file=sys.stderr)
        return 2

    print(f"\n{seen} events", file=sys.stderr)
    if refused and not seen:
        # Nothing arrived and we know exactly why. Worth repeating: the refusal
        # may have scrolled past minutes ago. Point at the driver rather than
        # the gloves — when every glove is refused, the driver is the cause.
        print(f"no pinches: all {len(refused)} glove(s) were refused, see above."
              " Nothing was read from them.\nIf they were refused on protocol"
              " version, restart the driver rather than the gloves.",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
