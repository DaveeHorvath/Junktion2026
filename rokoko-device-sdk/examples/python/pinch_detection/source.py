"""The driver's RGMP stream, turned into one frame per hand.

The socket, the framing and the per-device stream layout all come from
``rgmp_core.RgmpClient``, which every RGMP example here shares. What is left is
the glove-specific part: pick the devices that are gloves laid out the way a
pinch needs, and turn each of their data frames into a `HandFrame`.

`RgmpClient` is callback-driven, so this is too — `stream` calls back once per
decoded frame and returns when the driver closes.
"""

from __future__ import annotations

from typing import Callable

from rgmp_core.client import DEFAULT_PORT, RgmpClient
from solver_core.smartglove import is_smartglove

from pinch_detection.frames import GloveLayout, HandFrame, Unreadable

__all__ = ["DEFAULT_PORT", "stream"]

FrameHandler = Callable[[HandFrame], None]
SkipHandler = Callable[[dict], None]
RefusalHandler = Callable[[dict, Unreadable], None]


def stream(
    host: str = "127.0.0.1",
    port: int = DEFAULT_PORT,
    on_frame: FrameHandler = lambda _frame: None,
    on_other_device: SkipHandler = lambda _definition: None,
    on_refused: RefusalHandler = lambda _definition, _why: None,
) -> None:
    """Call *on_frame* for every glove frame until the driver closes.

    The driver publishes every device it has, so anything that is not a
    Smartglove — a Smartsuit, a Coil Pro — goes to *on_other_device* and is
    otherwise ignored. Report those somewhere the operator can see: a glove
    whose firmware omits `device_type` is indistinguishable from a device of
    another kind, and silently ignoring it would look like a dead stream.

    The driver publishes RGMP 2.0.0 by default. It needs ``--auto-stream-usb``
    for USB or serial gloves, without which it accepts the connection and
    publishes nothing at all.

    A glove this example will not decode — wrong protocol version, or no group
    a pinch could come from — goes to *on_refused* and is then ignored, rather
    than ending the session. One bad device should not take the others with it,
    and the operator needs to be told what to change. Say it loudly: nothing
    downstream will mention it again.

    Raises only what `RgmpClient` reports: protocol and socket errors.
    """
    gloves: dict[int, GloveLayout] = {}
    failure: list[Exception] = []

    def on_definition(definition, layout) -> None:
        if not is_smartglove(definition):
            on_other_device(definition)
            return
        # Reuses the layout RgmpClient has already built for this device.
        try:
            glove = GloveLayout(definition, layout)
        except Unreadable as why:
            on_refused(definition, why)
            return
        gloves[glove.device_id] = glove

    def on_data(device_id, group_id, t_us, payload, _layout) -> None:
        glove = gloves.get(device_id)
        if glove is not None and group_id == glove.group_id:
            on_frame(glove.frame(payload, t_us))

    def on_disconnect(device_id) -> None:
        gloves.pop(device_id, None)

    with RgmpClient(host, port) as client:
        client.on_definition = on_definition
        client.on_data = on_data
        client.on_disconnect = on_disconnect
        # Without this, run() would swallow a protocol or socket error and
        # return as though the driver had simply closed.
        client.on_error = failure.append
        client.run()

    if failure:
        raise failure[0]
