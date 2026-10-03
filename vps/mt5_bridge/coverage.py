"""Conservative coverage (port of Stage 3.0B-1 semantics).
An array returned by the terminal is never, by itself, proof of complete history:
availability depends on terminal history and 'Max. bars in chart'."""
from __future__ import annotations

import math
from typing import Optional, Sequence

from .contracts import BridgeBar, BridgeTick, HistoryCoverage

TIMEFRAME_SECONDS = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 14400, "D1": 86400}


def bar_coverage(bars: Sequence[BridgeBar], timeframe: str, from_s: Optional[int], to_s: Optional[int],
                 history_synced: bool = False) -> HistoryCoverage:
    n = len(bars)
    if n == 0:
        return HistoryCoverage(from_s, to_s, 0, None, None, "EMPTY",
                               "terminal returned zero bars; absence of data is not proof of no market activity")
    oldest, newest = bars[0].raw_time_s, bars[-1].raw_time_s
    step = TIMEFRAME_SECONDS[timeframe]
    for prev, cur in zip(bars, bars[1:]):
        if cur.raw_time_s - prev.raw_time_s != step:
            return HistoryCoverage(from_s, to_s, n, oldest, newest, "PARTIAL", f"internal gap after {prev.raw_time_s}")
    if from_s is None or to_s is None:
        return HistoryCoverage(from_s, to_s, n, oldest, newest, "UNKNOWN", "count-based request has no provable range")
    first_expected = math.ceil(from_s / step) * step
    last_expected = math.ceil(to_s / step) * step - step
    if oldest > first_expected or newest < last_expected:
        return HistoryCoverage(from_s, to_s, n, oldest, newest, "PARTIAL", "returned range does not span requested range")
    if not history_synced:
        return HistoryCoverage(from_s, to_s, n, oldest, newest, "UNKNOWN",
                               "contiguous, but terminal history sync is not proven")
    return HistoryCoverage(from_s, to_s, n, oldest, newest, "COMPLETE")


def tick_coverage(ticks: Sequence[BridgeTick], from_s: Optional[int], to_s: Optional[int]) -> HistoryCoverage:
    if not ticks:
        return HistoryCoverage(from_s, to_s, 0, None, None, "EMPTY", "terminal returned zero ticks")
    return HistoryCoverage(from_s, to_s, len(ticks), ticks[0].raw_time_msc, ticks[-1].raw_time_msc, "UNKNOWN",
                           "tick continuity cannot be proven from a terminal response")
