"""Transport-agnostic gateway service. Each approved route maps to ONE explicit handler that
calls ONE typed adapter method. There is no generic dispatch, no reflection on request
strings, and no path from the network to anything outside the frozen read-only whitelist."""
from __future__ import annotations

import asyncio
import re
import threading
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Awaitable, Callable, Mapping, Optional, Tuple
from urllib.parse import parse_qs, unquote

from mt5_bridge.adapter import ReadOnlyMT5Adapter
from mt5_bridge.contracts import Err, Ok
from mt5_bridge.coverage import TIMEFRAME_SECONDS

from .clock import TransportClock
from .envelope import Delivery, EnvelopeFactory, SourceMode, new_request_id

APPROVED_ROUTES: Tuple[Tuple[str, str], ...] = (
    ("GET", "/v1/health"),
    ("GET", "/v1/terminal"),
    ("GET", "/v1/symbols"),
    ("GET", "/v1/symbols/{symbol}"),
    ("GET", "/v1/ticks/latest/{symbol}"),
    ("GET", "/v1/ticks/{symbol}"),
    ("GET", "/v1/bars/{symbol}/{timeframe}"),
    ("WS", "/v1/stream"),
)
ALLOWED_TIMEFRAMES = frozenset(TIMEFRAME_SECONDS)
AUTHORITY_HEADER = ("X-Bridge-Authority", "READ_ONLY_OBSERVATION")

SYMBOL_RE = re.compile(r"^[A-Za-z0-9._#\-]{1,32}$")
GROUP_RE = re.compile(r"^[A-Za-z0-9*!,._\\\-]{1,64}$")
MAX_COUNT = 100_000

# Sanitized public messages (internal detail never leaves the process).
MSG_TERMINAL_UNAVAILABLE = "TERMINAL_UNAVAILABLE"
MSG_HISTORY_UNAVAILABLE = "HISTORY_UNAVAILABLE"
MSG_NATIVE_ERROR = "NATIVE_ERROR"
MSG_NOT_FOUND = "NOT_FOUND"
MSG_INTERNAL = "INTERNAL_GATEWAY_ERROR"


class RequestInvalid(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class HttpResult:
    status: int
    body: Mapping[str, Any]
    headers: Tuple[Tuple[str, str], ...] = (AUTHORITY_HEADER,)


def _bridge_error(kind: str, message: str, mt5: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    return {"kind": kind, "message": message, "mt5_error": mt5}


def parse_utc(value: str, name: str) -> datetime:
    """Timezone-aware ISO-8601 only. Naive input rejected; no broker offset applied."""
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        raise RequestInvalid(f"{name}: not an ISO-8601 datetime") from None
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise RequestInvalid(f"{name}: naive datetime rejected; include an explicit UTC offset")
    return dt


def _int(value: str, name: str, lo: int, hi: int) -> int:
    if not re.fullmatch(r"\d{1,9}", value):
        raise RequestInvalid(f"{name}: must be a non-negative integer")
    n = int(value)
    if not lo <= n <= hi:
        raise RequestInvalid(f"{name}: out of range [{lo}, {hi}]")
    return n


def _query(raw: str, allowed: frozenset[str]) -> dict[str, str]:
    try:
        q = parse_qs(raw, keep_blank_values=True, strict_parsing=bool(raw), max_num_fields=16)
    except ValueError:
        raise RequestInvalid("malformed query string") from None
    out: dict[str, str] = {}
    for k, vs in q.items():
        if k not in allowed:
            raise RequestInvalid(f"unknown query parameter: {k[:32]}")
        if len(vs) != 1:
            raise RequestInvalid(f"duplicate query parameter: {k}")
        out[k] = vs[0]
    return out


def _symbol(s: str) -> str:
    if not SYMBOL_RE.fullmatch(s):
        raise RequestInvalid("invalid symbol")
    return s


class GatewayService:
    def __init__(self, adapter: ReadOnlyMT5Adapter, clock: TransportClock,
                 source_mode: SourceMode = "SIMULATION", instance_id: Optional[str] = None) -> None:
        if not isinstance(adapter, ReadOnlyMT5Adapter):
            raise TypeError("gateway requires the frozen ReadOnlyMT5Adapter")
        self._adapter = adapter
        self._adapter_lock = threading.Lock()  # native API is not thread-safe
        self.envelopes = EnvelopeFactory(clock, source_mode, instance_id)
        self.internal_errors: list[str] = []   # internal only, never serialized

    # ---------- lifecycle (process-local; NOT reachable from the network) ----------
    def start(self) -> bool:
        with self._adapter_lock:
            return isinstance(self._adapter.initialize(), Ok)

    def reconnect(self) -> bool:
        with self._adapter_lock:
            self._adapter.shutdown()
            ok = isinstance(self._adapter.initialize(), Ok)
        self.envelopes.bump_epoch()
        return ok

    def stop(self) -> None:
        with self._adapter_lock:
            self._adapter.shutdown()

    async def _call(self, fn: Callable[[], Any]) -> Any:
        def locked() -> Any:
            with self._adapter_lock:
                return fn()
        return await asyncio.to_thread(locked)

    # ---------- envelope helpers ----------
    def _env(self, rid: str, cap: str, delivery: Delivery, recv: int, *, data: Any = None,
             error: Optional[dict[str, Any]] = None, source_event_at: Optional[int] = None) -> dict[str, Any]:
        return self.envelopes.build(request_id=rid, capability=cap, delivery=delivery, received_at=recv,
                                    data=data, error=error, source_event_at=source_event_at)

    def _map_err(self, err: Err, history: bool = False, lookup: bool = False) -> Tuple[int, dict[str, Any]]:
        e = err.error
        mt5 = e.mt5_error.to_wire() if e.mt5_error is not None else None
        if e.kind == "INVALID_REQUEST" and e.mt5_error is None:
            # 2A's "not initialized" — from the network's view the terminal is unavailable.
            return 503, _bridge_error("MT5_ERROR", MSG_TERMINAL_UNAVAILABLE, None)
        if e.kind == "MT5_ERROR":
            if lookup and mt5 is not None and mt5["code"] == 1:
                return 404, _bridge_error("NOT_FOUND", MSG_NOT_FOUND, None)
            return 502, _bridge_error("MT5_ERROR", MSG_HISTORY_UNAVAILABLE if history else MSG_NATIVE_ERROR, mt5)
        if e.kind in ("NOT_FOUND", "INVALID_REQUEST", "CAPABILITY_DENIED"):
            status = {"NOT_FOUND": 404, "INVALID_REQUEST": 400, "CAPABILITY_DENIED": 403}[e.kind]
            return status, _bridge_error(e.kind, e.kind, mt5)
        return 500, _bridge_error("MT5_ERROR", MSG_INTERNAL, None)

    # ---------- HTTP entry ----------
    async def handle_http(self, method: str, target: str) -> HttpResult:
        recv = self.envelopes.received()
        rid = new_request_id()
        path, _, raw_q = target.partition("?")
        match = self._route(path)
        if match is None:
            return HttpResult(404, {"detail": "not found"})
        cap, delivery, handler, params = match
        if method != "GET":
            return HttpResult(405, {"detail": "method not allowed"}, (AUTHORITY_HEADER, ("Allow", "GET")))
        try:
            status, env = await handler(rid, recv, params, raw_q)
        except RequestInvalid as ex:
            status, env = 400, self._env(rid, cap, delivery, recv,
                                         error=_bridge_error("INVALID_REQUEST", ex.message))
        except Exception as ex:  # sanitized: no traceback/internal detail leaves the process
            self.internal_errors.append(f"{type(ex).__name__}: {ex}")
            status, env = 500, self._env(rid, cap, delivery, recv, error=_bridge_error("MT5_ERROR", MSG_INTERNAL))
        return HttpResult(status, env)

    Handler = Callable[[str, int, Tuple[str, ...], str], Awaitable[Tuple[int, dict[str, Any]]]]

    def _route(self, path: str) -> Optional[Tuple[str, Delivery, "GatewayService.Handler", Tuple[str, ...]]]:
        """Static path table. Path segments are DATA (symbol/timeframe), never method names."""
        parts = path.split("/")
        if len(parts) < 3 or parts[0] != "" or parts[1] != "v1":
            return None
        seg = tuple(unquote(p) for p in parts[2:])
        if seg == ("health",):
            return "SYSTEM.HEALTH", "LIVE", self._health, ()
        if seg == ("terminal",):
            return "SYSTEM.TERMINAL_INFO", "LIVE", self._terminal, ()
        if seg == ("symbols",):
            return "DISCOVERY.SYMBOLS", "LIVE", self._symbols, ()
        if len(seg) == 2 and seg[0] == "symbols" and seg[1]:
            return "DISCOVERY.SYMBOL_SPEC", "LIVE", self._symbol_spec, (seg[1],)
        if len(seg) == 3 and seg[:2] == ("ticks", "latest") and seg[2]:
            return "MARKET_DATA.TICKS", "LIVE", self._latest_tick, (seg[2],)
        if len(seg) == 2 and seg[0] == "ticks" and seg[1] and seg[1] != "latest":
            return "MARKET_DATA.TICKS", "BACKFILL", self._ticks, (seg[1],)
        if len(seg) == 3 and seg[0] == "bars" and seg[1] and seg[2]:
            return "MARKET_DATA.BARS", "BACKFILL", self._bars, (seg[1], seg[2])
        return None

    # ---------- handlers ----------
    async def _health(self, rid: str, recv: int, p: Tuple[str, ...], q: str) -> Tuple[int, dict[str, Any]]:
        _query(q, frozenset())
        ti = await self._call(self._adapter.terminal_info)
        connected = isinstance(ti, Ok) and bool(ti.data.connected)
        data = {"bridge_instance_id": self.envelopes.instance_id, "connection_epoch": self.envelopes.epoch,
                "source_mode": self.envelopes.source_mode, "terminal_connected": connected}
        return 200, self._env(rid, "SYSTEM.HEALTH", "LIVE", recv, data=data)

    async def _terminal(self, rid: str, recv: int, p: Tuple[str, ...], q: str) -> Tuple[int, dict[str, Any]]:
        _query(q, frozenset())
        r = await self._call(self._adapter.terminal_info)
        if isinstance(r, Err):
            st, e = self._map_err(r)
            return st, self._env(rid, "SYSTEM.TERMINAL_INFO", "LIVE", recv, error=e)
        return 200, self._env(rid, "SYSTEM.TERMINAL_INFO", "LIVE", recv, data=r.data.to_wire())

    async def _symbols(self, rid: str, recv: int, p: Tuple[str, ...], q: str) -> Tuple[int, dict[str, Any]]:
        args = _query(q, frozenset({"group"}))
        group = args.get("group")
        if group is not None and not GROUP_RE.fullmatch(group):
            raise RequestInvalid("invalid group filter")
        r = await self._call(lambda: self._adapter.symbols_get(group))
        if isinstance(r, Err):
            st, e = self._map_err(r)
            return st, self._env(rid, "DISCOVERY.SYMBOLS", "LIVE", recv, error=e)
        # Filter is an optimization only: every candidate is returned, none is auto-selected.
        return 200, self._env(rid, "DISCOVERY.SYMBOLS", "LIVE", recv, data=[s.to_wire() for s in r.data])

    async def _symbol_spec(self, rid: str, recv: int, p: Tuple[str, ...], q: str) -> Tuple[int, dict[str, Any]]:
        _query(q, frozenset())
        sym = _symbol(p[0])
        r = await self._call(lambda: self._adapter.symbol_info(sym))
        if isinstance(r, Err):
            st, e = self._map_err(r, lookup=True)
            return st, self._env(rid, "DISCOVERY.SYMBOL_SPEC", "LIVE", recv, error=e)
        return 200, self._env(rid, "DISCOVERY.SYMBOL_SPEC", "LIVE", recv, data=r.data.to_wire())

    async def _latest_tick(self, rid: str, recv: int, p: Tuple[str, ...], q: str) -> Tuple[int, dict[str, Any]]:
        _query(q, frozenset())
        return await self.latest_tick_envelope(_symbol(p[0]), rid, recv)

    async def latest_tick_envelope(self, sym: str, rid: str, recv: int) -> Tuple[int, dict[str, Any]]:
        r = await self._call(lambda: self._adapter.symbol_info_tick(sym))
        if isinstance(r, Err):
            st, e = self._map_err(r, lookup=True)
            return st, self._env(rid, "MARKET_DATA.TICKS", "LIVE", recv, error=e)
        return 200, self._env(rid, "MARKET_DATA.TICKS", "LIVE", recv, data=r.data.to_wire(),
                              source_event_at=r.data.raw_time_msc)

    async def _ticks(self, rid: str, recv: int, p: Tuple[str, ...], q: str) -> Tuple[int, dict[str, Any]]:
        sym = _symbol(p[0])
        a = _query(q, frozenset({"mode", "from", "to", "count"}))
        mode = a.get("mode")
        if mode == "range":
            if set(a) != {"mode", "from", "to"}:
                raise RequestInvalid("mode=range requires exactly: from, to")
            f, t = parse_utc(a["from"], "from"), parse_utc(a["to"], "to")
            if f >= t:
                raise RequestInvalid("from must be earlier than to")
            r = await self._call(lambda: self._adapter.copy_ticks_range(sym, f, t))
        elif mode == "from":
            if set(a) != {"mode", "from", "count"}:
                raise RequestInvalid("mode=from requires exactly: from, count")
            f, n = parse_utc(a["from"], "from"), _int(a["count"], "count", 1, MAX_COUNT)
            r = await self._call(lambda: self._adapter.copy_ticks_from(sym, f, n))
        else:
            raise RequestInvalid("mode must be one of: range, from")
        if isinstance(r, Err):
            st, e = self._map_err(r, history=True)
            return st, self._env(rid, "MARKET_DATA.TICKS", "BACKFILL", recv, error=e)
        return 200, self._env(rid, "MARKET_DATA.TICKS", "BACKFILL", recv, data=r.data.to_wire())

    async def _bars(self, rid: str, recv: int, p: Tuple[str, ...], q: str) -> Tuple[int, dict[str, Any]]:
        sym = _symbol(p[0])
        tf = p[1]
        if tf not in ALLOWED_TIMEFRAMES:  # rejected BEFORE any native invocation
            raise RequestInvalid("unsupported timeframe")
        a = _query(q, frozenset({"mode", "from", "to", "count", "start"}))
        mode = a.get("mode")
        if mode == "range":
            if set(a) != {"mode", "from", "to"}:
                raise RequestInvalid("mode=range requires exactly: from, to")
            f, t = parse_utc(a["from"], "from"), parse_utc(a["to"], "to")
            if f >= t:
                raise RequestInvalid("from must be earlier than to")
            r = await self._call(lambda: self._adapter.copy_rates_range(sym, tf, f, t))
        elif mode == "from":
            if set(a) != {"mode", "from", "count"}:
                raise RequestInvalid("mode=from requires exactly: from, count")
            f, n = parse_utc(a["from"], "from"), _int(a["count"], "count", 1, MAX_COUNT)
            r = await self._call(lambda: self._adapter.copy_rates_from(sym, tf, f, n))
        elif mode == "pos":
            if set(a) != {"mode", "start", "count"}:
                raise RequestInvalid("mode=pos requires exactly: start, count")
            s, n = _int(a["start"], "start", 0, MAX_COUNT), _int(a["count"], "count", 1, MAX_COUNT)
            r = await self._call(lambda: self._adapter.copy_rates_from_pos(sym, tf, s, n))
        else:
            raise RequestInvalid("mode must be one of: range, from, pos")
        if isinstance(r, Err):
            st, e = self._map_err(r, history=True)
            return st, self._env(rid, "MARKET_DATA.BARS", "BACKFILL", recv, error=e)
        return 200, self._env(rid, "MARKET_DATA.BARS", "BACKFILL", recv, data=r.data.to_wire())

    # ---------- stream ----------
    def validate_subscription(self, msg: Any) -> Tuple[str, ...]:
        if not isinstance(msg, dict) or set(msg) != {"action", "stream", "symbols"}:
            raise RequestInvalid("subscription must have exactly: action, stream, symbols")
        if msg["action"] != "subscribe":
            raise RequestInvalid("only action=subscribe is accepted")
        if msg["stream"] != "ticks":
            raise RequestInvalid("only stream=ticks is accepted")
        syms = msg["symbols"]
        if not isinstance(syms, list) or not 1 <= len(syms) <= 10 or not all(isinstance(s, str) for s in syms):
            raise RequestInvalid("symbols must be a list of 1..10 strings")
        return tuple(_symbol(s) for s in syms)

    async def stream_events(self, raw: Any) -> list[dict[str, Any]]:
        recv = self.envelopes.received()
        try:
            syms = self.validate_subscription(raw)
        except RequestInvalid as ex:
            return [self._env(new_request_id(), "MARKET_DATA.TICKS", "LIVE", recv,
                              error=_bridge_error("INVALID_REQUEST", ex.message))]
        out = []
        for s in syms:
            _, env = await self.latest_tick_envelope(s, new_request_id(), self.envelopes.received())
            out.append(env)
        return out

    def stream_invalid(self, message: str) -> dict[str, Any]:
        return self._env(new_request_id(), "MARKET_DATA.TICKS", "LIVE", self.envelopes.received(),
                         error=_bridge_error("INVALID_REQUEST", message))
