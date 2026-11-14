"""Fan-out: one solved frame in, every connected consumer out.

Each device is announced once, so a consumer that connects later needs that
definition replayed before it can decode anything. Announcements carry a
sequence number, which is how a connection tells a real re-announcement from
a replay of one it has already sent.
"""

from __future__ import annotations

import sys
import threading
from collections import deque
from dataclasses import dataclass

# Two hands x two groups x ~83 Hz is a couple of seconds of slack. Dropping
# is the right failure here: a stale pose is worth less than the next one.
CHANNEL_CAPACITY = 1024


@dataclass(frozen=True)
class Definition:
    """`seq` increases with every announcement, replay or not."""

    device_id: int
    seq: int
    frame: bytes


@dataclass(frozen=True)
class Data:
    frame: bytes


@dataclass(frozen=True)
class Disconnect:
    device_id: int
    frame: bytes


@dataclass(frozen=True)
class Lagged:
    n_missed_frames: int


Publish = Definition | Data | Disconnect


def _log(message: str) -> None:
    print(f"hand_solver: {message}", file=sys.stderr)


class Subscription:
    """A bounded queue that drops the oldest frame and counts the loss."""

    def __init__(self, capacity: int = CHANNEL_CAPACITY) -> None:
        self._cond = threading.Condition()
        self._queue: deque[Publish] = deque()
        self._capacity = capacity
        self._n_missed_frames = 0
        self._closed = False

    def _push(self, message: Publish) -> None:
        with self._cond:
            if self._closed:
                return
            if len(self._queue) >= self._capacity:
                self._queue.popleft()
                self._n_missed_frames += 1
            self._queue.append(message)
            self._cond.notify()

    def next_message(self, timeout: float | None = None) -> Publish | Lagged | None:
        with self._cond:
            while not self._queue and not self._closed:
                if not self._cond.wait(timeout):
                    return None
            if self._n_missed_frames:
                missed, self._n_missed_frames = self._n_missed_frames, 0
                return Lagged(missed)
            if self._queue:
                return self._queue.popleft()
            return None

    def close(self) -> None:
        with self._cond:
            self._closed = True
            self._cond.notify_all()


class Hub:
    """Shared state between the upstream reader and every consumer."""

    def __init__(self, capacity: int = CHANNEL_CAPACITY) -> None:
        self._lock = threading.Lock()
        self._capacity = capacity
        self._subscribers: list[Subscription] = []
        # Current definition per device, with the sequence number it was
        # published under.
        self._definitions: dict[int, tuple[int, bytes]] = {}
        self._next_seq = 1

    # ── Publishing ────────────────────────────────────────────────────────────

    def publish_definition(self, device_id: int, frame: bytes) -> None:
        # Held across the fan-out so the snapshot and the queues agree.
        with self._lock:
            seq = self._next_seq
            self._next_seq += 1
            self._definitions[device_id] = (seq, frame)
            self._send(Definition(device_id, seq, frame))

    def publish_data(self, frame: bytes) -> None:
        with self._lock:
            self._send(Data(frame))

    def publish_disconnect(self, device_id: int, frame: bytes) -> None:
        with self._lock:
            self._definitions.pop(device_id, None)
            self._send(Disconnect(device_id, frame))

    def _send(self, message: Publish) -> None:
        for subscriber in self._subscribers:
            subscriber._push(message)

    # ── Subscribing ───────────────────────────────────────────────────────────

    def subscribe(self) -> Subscription:
        subscription = Subscription(self._capacity)
        with self._lock:
            self._subscribers.append(subscription)
        return subscription

    def unsubscribe(self, subscription: Subscription) -> None:
        with self._lock:
            if subscription in self._subscribers:
                self._subscribers.remove(subscription)
        subscription.close()

    def close(self) -> None:
        """Wake every consumer so it can shut down."""
        with self._lock:
            subscribers, self._subscribers = self._subscribers, []
        for subscription in subscribers:
            subscription.close()

    # ── State ─────────────────────────────────────────────────────────────────

    def snapshot(self) -> list[tuple[int, int, bytes]]:
        """Every current definition, device-ordered."""
        with self._lock:
            return [
                (device_id, *self._definitions[device_id])
                for device_id in sorted(self._definitions)
            ]

    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)


def serve_consumer(send, hub: Hub, subscription: Subscription | None = None) -> None:
    """Feed one consumer until it goes away.

    `send(frame)` raises `OSError` when the peer is gone — `socket.sendall` in
    production, a recorder in tests.
    """
    # Subscribe before snapshotting, so nothing published in between is lost;
    # `sent` settles the duplicate that allows.
    own_subscription = subscription is None
    if subscription is None:
        subscription = hub.subscribe()
    sent: dict[int, int] = {}

    try:
        if not _replay_definitions(send, hub, sent):
            return

        while True:
            message = subscription.next_message()
            if message is None:
                return

            if isinstance(message, Definition):
                # Newer than what we sent is a real announcement; older is the
                # replay above.
                if sent.get(message.device_id, -1) >= message.seq:
                    continue
                sent[message.device_id] = message.seq
                if not _write(send, message.frame):
                    return
            elif isinstance(message, Data):
                if not _write(send, message.frame):
                    return
            elif isinstance(message, Disconnect):
                sent.pop(message.device_id, None)
                if not _write(send, message.frame):
                    return
            else:  # Lagged — what was dropped may have been a definition.
                _log(
                    f"consumer fell behind, dropped {message.n_missed_frames} frames; "
                    "re-sending definitions"
                )
                if not _replay_definitions(send, hub, sent):
                    return
    finally:
        if own_subscription:
            hub.unsubscribe(subscription)


def _replay_definitions(send, hub: Hub, sent: dict[int, int]) -> bool:
    """False when the peer is gone."""
    for device_id, seq, frame in hub.snapshot():
        if sent.get(device_id, -1) >= seq:
            continue
        sent[device_id] = seq
        if not _write(send, frame):
            return False
    return True


def _write(send, frame: bytes) -> bool:
    try:
        send(frame)
    except OSError:
        return False
    return True
