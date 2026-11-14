"""Measure the solver-hop latency: how long a sample takes to reappear
on the solved stream after the driver emitted it.

Method: two raw RGMP taps in one process (one clock) — the driver's
port and the solver's port. The solver re-emits source timestamps
unchanged, so a `(device_id, timestamp_us)` pair seen on both sides
identifies the same sample, and the arrival-time difference is the
solve + re-emit + transport hop. Run it on the host closest to the
solver; add network RTT separately when the consumer is remote.

    python3 -m isaac.tools.measure_hop_latency \\
        --driver 127.0.0.1:12276 --solver 127.0.0.1:12277 --seconds 10
"""

from __future__ import annotations

import argparse
import statistics
import sys
import threading
import time
from pathlib import Path

if __package__ in (None, ""):  # `python3 isaac/tools/measure_hop_latency.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from rgmp_core.client import RgmpClient


class _Tap(threading.Thread):
    """Records the first arrival time of every (device_id, timestamp_us)."""

    def __init__(self, name: str, host: str, port: int) -> None:
        super().__init__(name=f"tap-{name}", daemon=True)
        self.host, self.port = host, port
        self.firsts: dict[tuple[int, int], float] = {}
        self._lock = threading.Lock()
        self._client: RgmpClient | None = None

    def run(self) -> None:
        with RgmpClient(self.host, self.port, timeout=5.0) as client:
            self._client = client
            client._socket.settimeout(None)  # connect timeout only
            client.on_data = self._on_data
            try:
                client.run()
            except RuntimeError:
                pass  # closed from stop()

    def _on_data(self, device_id: int, _gid: int, ts_us: int, _payload, _layout) -> None:
        key = (device_id, ts_us)
        now = time.monotonic()
        with self._lock:
            self.firsts.setdefault(key, now)

    def stop(self) -> None:
        client = self._client
        if client is not None:
            try:
                client.__exit__(None, None, None)
            except OSError:
                pass


def endpoint(raw: str) -> tuple[str, int]:
    host, _, port = raw.rpartition(":")
    return host, int(port)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--driver", default="127.0.0.1:12276")
    parser.add_argument("--solver", default="127.0.0.1:12277")
    parser.add_argument("--seconds", type=float, default=10.0)
    args = parser.parse_args()

    taps = [_Tap("driver", *endpoint(args.driver)), _Tap("solver", *endpoint(args.solver))]
    for tap in taps:
        tap.start()
    time.sleep(args.seconds)
    for tap in taps:
        tap.stop()
    for tap in taps:
        tap.join(timeout=5.0)

    driver, solver = taps
    deltas_ms = [
        (solver.firsts[key] - t_driver) * 1000.0
        for key, t_driver in driver.firsts.items()
        if key in solver.firsts
    ]
    if not deltas_ms:
        raise SystemExit(
            f"no matched samples (driver saw {len(driver.firsts)}, "
            f"solver {len(solver.firsts)}) — are both streams up?"
        )
    deltas_ms.sort()
    n = len(deltas_ms)
    print(
        f"solver hop latency over {n} samples: "
        f"mean {statistics.fmean(deltas_ms):.2f} ms, "
        f"p50 {deltas_ms[n // 2]:.2f} ms, "
        f"p95 {deltas_ms[int(n * 0.95)]:.2f} ms, "
        f"max {deltas_ms[-1]:.2f} ms"
    )


if __name__ == "__main__":
    main()
