"""Stage 3.0B-2A ReadOnlyMT5Adapter.
Connects to an ALREADY-AUTHENTICATED terminal session. Accepts no account identity
or secrets. Normalizes native structures into the frozen 3.0B-1 contract; adds no
decision semantics. Time requests are explicit UTC; no broker offset is applied."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, List, Optional, Tuple, TypeVar, Union

from .contracts import (
    AdapterResult, BridgeBar, BridgeError, BridgeSymbolInfo, BridgeTick, Err, HistoryResult, Mt5Error, Ok,
    TerminalInfoObservation, TerminalVersion,
)
from .coverage import TIMEFRAME_SECONDS, bar_coverage, tick_coverage
from .native import NATIVE_WHITELIST, NativeCapabilityDenied, WhitelistedNative

T = TypeVar("T")
UtcTime = Union[datetime, int]


@dataclass(frozen=True)
class AdapterConfig:
    """Terminal location only. Deliberately has no account identity / secret fields."""
    terminal_path: Optional[str] = None
    timeout_ms: Optional[int] = None
    portable: bool = False


@dataclass(frozen=True)
class RawErrorProvenance:
    native_call: str
    raw_last_error: Tuple[Any, ...]   # verbatim, internal only


def to_utc(t: UtcTime) -> datetime:
    """Explicit UTC request time. Naive datetimes are rejected (VPS-local ambiguity)."""
    if isinstance(t, bool):
        raise TypeError("bool is not a time")
    if isinstance(t, int):
        return datetime.fromtimestamp(t, tz=timezone.utc)
    if isinstance(t, datetime):
        if t.tzinfo is None or t.utcoffset() is None:
            raise ValueError("naive datetime rejected: request times must be timezone-aware UTC")
        return t.astimezone(timezone.utc)
    raise TypeError(f"unsupported time type {type(t).__name__}")


def _f(obj: Any, name: str) -> Any:
    """Field access for namedtuple-like objects, numpy records and dicts."""
    try:
        return obj[name]
    except (TypeError, KeyError, IndexError, ValueError):
        return getattr(obj, name)


def _epoch(dt: datetime) -> int:
    return int(dt.timestamp())


class ReadOnlyMT5Adapter:
    def __init__(self, native: Any, config: AdapterConfig = AdapterConfig()) -> None:
        self._n = native if isinstance(native, WhitelistedNative) else WhitelistedNative(native)
        self._cfg = config
        self._initialized = False
        self._provenance: List[RawErrorProvenance] = []

    # ---------- internals ----------
    @property
    def initialized(self) -> bool:
        return self._initialized

    def internal_error_provenance(self) -> Tuple[RawErrorProvenance, ...]:
        return tuple(self._provenance)

    def _native(self, name: str) -> Callable[..., Any]:
        if name not in NATIVE_WHITELIST:
            raise NativeCapabilityDenied(name)
        fn: Callable[..., Any] = getattr(self._n, name)
        return fn

    def _mt5_err(self, call: str) -> Err:
        raw = self._native("last_error")()
        raw_t = tuple(raw) if raw is not None else (None, None)
        self._provenance.append(RawErrorProvenance(call, raw_t))
        code = int(raw_t[0]) if raw_t and raw_t[0] is not None else -1
        desc = str(raw_t[1]) if len(raw_t) > 1 and raw_t[1] is not None else "unknown"
        return Err(BridgeError("MT5_ERROR", f"{call} failed", Mt5Error(code, desc)))

    def _need_init(self) -> Optional[Err]:
        return None if self._initialized else Err(BridgeError("INVALID_REQUEST", "adapter not initialized", None))

    def _call(self, name: str, *args: Any, fail_on_false: bool = False) -> Tuple[Any, Optional[Err]]:
        res = self._native(name)(*args)
        if res is None or (fail_on_false and res is False):
            return None, self._mt5_err(name)
        return res, None

    # ---------- SYSTEM ----------
    def initialize(self) -> AdapterResult[bool]:
        kw: dict[str, Any] = {}
        if self._cfg.terminal_path is not None:
            kw["path"] = self._cfg.terminal_path
        if self._cfg.timeout_ms is not None:
            kw["timeout"] = self._cfg.timeout_ms
        if self._cfg.portable:
            kw["portable"] = True
        if not self._native("initialize")(**kw):
            return self._mt5_err("initialize")
        self._initialized = True
        return Ok(True)

    def shutdown(self) -> AdapterResult[bool]:
        if self._initialized:
            self._native("shutdown")()
        self._initialized = False
        return Ok(True)

    def version(self) -> AdapterResult[TerminalVersion]:
        if (e := self._need_init()):
            return e
        v, err = self._call("version")
        if err:
            return err
        return Ok(TerminalVersion(int(v[0]), int(v[1]), str(v[2])))

    def terminal_info(self) -> AdapterResult[TerminalInfoObservation]:
        if (e := self._need_init()):
            return e
        ti, err = self._call("terminal_info")
        if err:
            return err
        ping_us = int(_f(ti, "ping_last"))
        return Ok(TerminalInfoObservation(
            connected=bool(_f(ti, "connected")), terminal_ping_us=ping_us, terminal_ping_ms=ping_us / 1000,
            retransmission=float(_f(ti, "retransmission")),
            trade_allowed_observed=bool(_f(ti, "trade_allowed")),
            tradeapi_disabled_observed=bool(_f(ti, "tradeapi_disabled")),
        ))

    def last_error(self) -> Mt5Error:
        raw = tuple(self._native("last_error")())
        return Mt5Error(int(raw[0]), str(raw[1]))

    # ---------- DISCOVERY ----------
    @staticmethod
    def _sym(s: Any) -> BridgeSymbolInfo:
        return BridgeSymbolInfo(str(_f(s, "name")), str(_f(s, "description")), str(_f(s, "path")),
                                str(_f(s, "currency_base")), str(_f(s, "currency_profit")), int(_f(s, "digits")),
                                float(_f(s, "point")), float(_f(s, "trade_contract_size")))

    def symbols_get(self, group: Optional[str] = None) -> AdapterResult[Tuple[BridgeSymbolInfo, ...]]:
        if (e := self._need_init()):
            return e
        res = self._native("symbols_get")(group=group) if group is not None else self._native("symbols_get")()
        if res is None:
            return self._mt5_err("symbols_get")
        return Ok(tuple(self._sym(s) for s in res))

    def symbol_info(self, symbol: str) -> AdapterResult[BridgeSymbolInfo]:
        if (e := self._need_init()):
            return e
        s, err = self._call("symbol_info", symbol)
        return err or Ok(self._sym(s))

    def symbol_select(self, symbol: str, enable: bool = True) -> AdapterResult[bool]:
        if (e := self._need_init()):
            return e
        _, err = self._call("symbol_select", symbol, enable, fail_on_false=True)
        return err or Ok(True)

    # ---------- MARKET_DATA ----------
    @staticmethod
    def _tick(symbol: str, t: Any) -> BridgeTick:
        return BridgeTick(symbol, int(_f(t, "time")), int(_f(t, "time_msc")), float(_f(t, "bid")), float(_f(t, "ask")),
                          float(_f(t, "last")), float(_f(t, "volume")), int(_f(t, "flags")))

    @staticmethod
    def _bar(symbol: str, tf: str, r: Any) -> BridgeBar:
        return BridgeBar(symbol, tf, int(_f(r, "time")), float(_f(r, "open")), float(_f(r, "high")), float(_f(r, "low")),
                         float(_f(r, "close")), int(_f(r, "tick_volume")), int(_f(r, "spread")), int(_f(r, "real_volume")))

    def _tf(self, timeframe: str) -> Any:
        if timeframe not in TIMEFRAME_SECONDS:
            raise ValueError(f"unsupported timeframe {timeframe}")
        return getattr(self._n, f"TIMEFRAME_{timeframe}")

    def symbol_info_tick(self, symbol: str) -> AdapterResult[BridgeTick]:
        if (e := self._need_init()):
            return e
        t, err = self._call("symbol_info_tick", symbol)
        return err or Ok(self._tick(symbol, t))

    def _ticks(self, call: str, symbol: str, args: Tuple[Any, ...], from_s: Optional[int], to_s: Optional[int]
               ) -> AdapterResult[HistoryResult[BridgeTick]]:
        if (e := self._need_init()):
            return e
        res, err = self._call(call, symbol, *args)
        if err:
            return err
        items = tuple(self._tick(symbol, t) for t in res)
        return Ok(HistoryResult(items, tick_coverage(items, from_s, to_s)))

    def copy_ticks_from(self, symbol: str, date_from: UtcTime, count: int, flags: Optional[int] = None):
        dt = to_utc(date_from)
        fl = self._n.COPY_TICKS_ALL if flags is None else flags
        return self._ticks("copy_ticks_from", symbol, (dt, count, fl), _epoch(dt), None)

    def copy_ticks_range(self, symbol: str, date_from: UtcTime, date_to: UtcTime, flags: Optional[int] = None):
        a, b = to_utc(date_from), to_utc(date_to)
        fl = self._n.COPY_TICKS_ALL if flags is None else flags
        return self._ticks("copy_ticks_range", symbol, (a, b, fl), _epoch(a), _epoch(b))

    def _rates(self, call: str, symbol: str, timeframe: str, args: Tuple[Any, ...], from_s: Optional[int],
               to_s: Optional[int]) -> AdapterResult[HistoryResult[BridgeBar]]:
        if (e := self._need_init()):
            return e
        res, err = self._call(call, symbol, self._tf(timeframe), *args)
        if err:
            return err
        items = tuple(self._bar(symbol, timeframe, r) for r in res)
        # history_synced=False: 2A has no mechanism to prove terminal history continuity.
        return Ok(HistoryResult(items, bar_coverage(items, timeframe, from_s, to_s, history_synced=False)))

    def copy_rates_from(self, symbol: str, timeframe: str, date_from: UtcTime, count: int):
        dt = to_utc(date_from)
        return self._rates("copy_rates_from", symbol, timeframe, (dt, count), None, _epoch(dt))

    def copy_rates_from_pos(self, symbol: str, timeframe: str, start_pos: int, count: int):
        return self._rates("copy_rates_from_pos", symbol, timeframe, (start_pos, count), None, None)

    def copy_rates_range(self, symbol: str, timeframe: str, date_from: UtcTime, date_to: UtcTime):
        a, b = to_utc(date_from), to_utc(date_to)
        return self._rates("copy_rates_range", symbol, timeframe, (a, b), _epoch(a), _epoch(b))
