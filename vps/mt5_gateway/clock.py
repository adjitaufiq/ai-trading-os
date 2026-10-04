"""Injectable TRANSPORT clock. Bridge-side wall time is observation metadata only; it never
becomes market-event truth (raw_time_s / raw_time_msc are never touched)."""
from __future__ import annotations

import threading
import time
from typing import Protocol


class TransportClock(Protocol):
    def now_ms(self) -> int: ...


class WallTransportClock:
    """The single wall-clock read in the gateway package. Monotonic non-decreasing."""

    def __init__(self) -> None:
        self._last = 0
        self._lock = threading.Lock()

    def now_ms(self) -> int:
        with self._lock:
            self._last = max(self._last, time.time_ns() // 1_000_000)
            return self._last


class FakeTransportClock:
    """Deterministic clock for tests: each read advances by `step_ms`."""

    def __init__(self, start_ms: int, step_ms: int = 1) -> None:
        self._t = start_ms
        self._step = step_ms
        self._lock = threading.Lock()

    def now_ms(self) -> int:
        with self._lock:
            t = self._t
            self._t += self._step
            return t
