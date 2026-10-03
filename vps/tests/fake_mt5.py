"""Deterministic fake of the native module. Contains forbidden members ON PURPOSE,
so tests can prove the adapter/proxy never reaches them."""
from __future__ import annotations

from collections import namedtuple
from datetime import datetime, timezone

TerminalInfo = namedtuple("TerminalInfo", "connected ping_last retransmission trade_allowed tradeapi_disabled")
SymbolInfo = namedtuple("SymbolInfo", "name description path currency_base currency_profit digits point trade_contract_size")
Tick = namedtuple("Tick", "time bid ask last volume time_msc flags volume_real")

T0 = int(datetime(2026, 1, 5, 8, 0, tzinfo=timezone.utc).timestamp())

SYMBOLS = [
    SymbolInfo("XAUUSDm", "Gold", "Metals\\Standard", "XAU", "USD", 2, 0.01, 100.0),
    SymbolInfo("XAUUSDz", "Gold", "Metals\\Zero", "XAU", "USD", 2, 0.01, 100.0),
    SymbolInfo("BTCUSDm", "Bitcoin", "Crypto\\Standard", "BTC", "USD", 2, 0.01, 1.0),
]
TICKS = [  # dict rows mimic numpy structured records
    {"time": T0, "bid": 2345.10, "ask": 2345.22, "last": 0.0, "volume": 0, "time_msc": T0 * 1000 + 7, "flags": 6, "volume_real": 0.0},
    {"time": T0 + 1, "bid": 2345.20, "ask": 2345.32, "last": 0.0, "volume": 0, "time_msc": T0 * 1000 + 1257, "flags": 6, "volume_real": 0.0},
]


def bar(i: int, o: float) -> dict:
    return {"time": T0 + i * 300, "open": o, "high": o + 1, "low": o - 1, "close": o + 0.5,
            "tick_volume": 10 + i, "spread": 12, "real_volume": 0}


BARS = [bar(0, 2345.1), bar(1, 2345.6), bar(2, 2346.1)]
BARS_GAPPED = [bar(0, 2345.1), bar(1, 2345.6), bar(3, 2346.1)]


class FakeMT5:
    TIMEFRAME_M5 = 5
    TIMEFRAME_H1 = 16385
    COPY_TICKS_ALL = -1

    def __init__(self, *, init_ok=True, fail=(), bars=None, ticks=None, ping_last=23_456, trade_allowed=True):
        self.calls: list[tuple] = []
        self.init_ok, self.fail = init_ok, set(fail)
        self.bars = BARS if bars is None else bars
        self.ticks = TICKS if ticks is None else ticks
        self.ping_last, self.trade_allowed = ping_last, trade_allowed
        self.err = (1, "Success")
        self.forbidden_hits: list[str] = []

    def _rec(self, name, *a, **kw):
        self.calls.append((name, a, kw))
        if name in self.fail:
            self.err = (-10005, f"IPC timeout in {name}")
            return True
        return False

    # whitelisted
    def initialize(self, **kw):
        self._rec("initialize", **kw)
        if not self.init_ok:
            self.err = (-6, "Terminal: Authorization failed")
        return self.init_ok

    def shutdown(self):
        self._rec("shutdown")
        return True

    def last_error(self):
        return self.err

    def version(self):
        return None if self._rec("version") else (500, 4620, "02 Oct 2026")

    def terminal_info(self):
        return None if self._rec("terminal_info") else TerminalInfo(True, self.ping_last, 0.4, self.trade_allowed, False)

    def symbols_get(self, group=None):
        if self._rec("symbols_get", group=group):
            return None
        return tuple(s for s in SYMBOLS if group is None or group.strip("*") in s.name)

    def symbol_info(self, symbol):
        if self._rec("symbol_info", symbol):
            return None
        return next((s for s in SYMBOLS if s.name == symbol), None)

    def symbol_select(self, symbol, enable=True):
        return not self._rec("symbol_select", symbol, enable) and any(s.name == symbol for s in SYMBOLS)

    def symbol_info_tick(self, symbol):
        return None if self._rec("symbol_info_tick", symbol) else Tick(**self.ticks[-1])

    def copy_ticks_from(self, symbol, date_from, count, flags):
        return None if self._rec("copy_ticks_from", symbol, date_from, count, flags) else list(self.ticks[:count])

    def copy_ticks_range(self, symbol, date_from, date_to, flags):
        return None if self._rec("copy_ticks_range", symbol, date_from, date_to, flags) else list(self.ticks)

    def copy_rates_from(self, symbol, tf, date_from, count):
        return None if self._rec("copy_rates_from", symbol, tf, date_from, count) else list(self.bars[-count:])

    def copy_rates_from_pos(self, symbol, tf, start, count):
        return None if self._rec("copy_rates_from_pos", symbol, tf, start, count) else list(self.bars[:count])

    def copy_rates_range(self, symbol, tf, date_from, date_to):
        return None if self._rec("copy_rates_range", symbol, tf, date_from, date_to) else list(self.bars)

    # forbidden — must never be reached
    def _forbidden(name):  # noqa: N805
        def f(self, *a, **kw):
            self.forbidden_hits.append(name)
            raise AssertionError(f"forbidden native member called: {name}")
        return f

    login = _forbidden("login")
    account_info = _forbidden("account_info")
    orders_get = _forbidden("orders_get")
    positions_get = _forbidden("positions_get")
    history_orders_get = _forbidden("history_orders_get")
    history_deals_get = _forbidden("history_deals_get")
    order_check = _forbidden("order_check")
    order_send = _forbidden("order_send")
    order_calc_margin = _forbidden("order_calc_margin")
    order_calc_profit = _forbidden("order_calc_profit")
