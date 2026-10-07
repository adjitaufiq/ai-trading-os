"""Demo execution service. Every call re-validates the account identity (DEMO + login + server whitelist)
before touching anything; any other account refuses with ACCOUNT_BLOCKED. Orders carry a fixed magic number
and the signal_id as comment; a signal_id already seen (open position or history) is refused (DUPLICATE_SIGNAL)."""
from __future__ import annotations

import time
from typing import Any, Dict, FrozenSet, Optional

MAGIC = 610_006  # Phase 6A demo lab
DEVIATION_POINTS = 20


class AccountBlocked(Exception):
    pass


def _mode_name(n: Any, mode: int) -> str:
    if mode == getattr(n, "ACCOUNT_TRADE_MODE_DEMO", 0):
        return "DEMO"
    if mode == getattr(n, "ACCOUNT_TRADE_MODE_CONTEST", 1):
        return "CONTEST"
    if mode == getattr(n, "ACCOUNT_TRADE_MODE_REAL", 2):
        return "REAL"
    return "UNKNOWN"


class DemoExecService:
    def __init__(self, native: Any, logins: FrozenSet[int], servers: FrozenSet[str]) -> None:
        if not logins or not servers:
            raise ValueError("demo whitelist must not be empty")
        self._n = native
        self._logins = logins
        self._servers = servers

    # ---- identity binding ----
    def account(self) -> Dict[str, Any]:
        a = self._n.account_info()
        if a is None:
            raise AccountBlocked("IDENTITY_UNAVAILABLE")
        return {"login": int(a.login), "server": str(a.server), "trade_mode": _mode_name(self._n, int(a.trade_mode)),
                "balance": float(a.balance), "equity": float(a.equity), "currency": str(a.currency)}

    def _require_demo(self) -> Dict[str, Any]:
        a = self.account()
        if a["trade_mode"] != "DEMO":
            raise AccountBlocked("ACCOUNT_NOT_DEMO")
        if a["login"] not in self._logins:
            raise AccountBlocked("ACCOUNT_NOT_WHITELISTED")
        if a["server"] not in self._servers:
            raise AccountBlocked("SERVER_NOT_WHITELISTED")
        return a

    # ---- reads ----
    def symbol(self, name: str) -> Optional[Dict[str, Any]]:
        self._require_demo()
        s = self._n.symbol_info(name)
        if s is None:
            return None
        return {"volume_min": float(s.volume_min), "volume_max": float(s.volume_max), "volume_step": float(s.volume_step),
                "tick_size": float(s.trade_tick_size), "tick_value": float(s.trade_tick_value)}

    def positions(self) -> list:
        self._require_demo()
        rows = self._n.positions_get() or ()
        return [{"ticket": int(p.ticket), "symbol": str(p.symbol), "comment": str(p.comment)} for p in rows if int(p.magic) == MAGIC]

    def close_deal(self, position: int) -> Optional[Dict[str, Any]]:
        self._require_demo()
        deals = self._n.history_deals_get(position=position) or ()
        out = [d for d in deals if int(d.entry) == getattr(self._n, "DEAL_ENTRY_OUT", 1) and int(d.magic) == MAGIC]
        if not out:
            return None
        d = out[-1]
        r = int(d.reason)
        reason = "SL" if r == getattr(self._n, "DEAL_REASON_SL", 4) else "TP" if r == getattr(self._n, "DEAL_REASON_TP", 5) else "OTHER"
        return {"price": float(d.price), "profit": float(d.profit) + float(getattr(d, "swap", 0.0)) + float(getattr(d, "commission", 0.0)), "time": int(d.time), "reason": reason}

    def _signal_seen(self, signal_id: str) -> bool:
        comment = signal_id[:31]
        for p in self._n.positions_get() or ():
            if int(p.magic) == MAGIC and str(p.comment) == comment:
                return True
        for d in self._n.history_deals_get(0, int(time.time()) + 86_400) or ():
            if int(d.magic) == MAGIC and str(d.comment) == comment:
                return True
        return False

    # ---- the only write ----
    def send_order(self, body: Dict[str, Any]) -> Dict[str, Any]:
        self._require_demo()
        sid, symbol, direction = str(body.get("signal_id", "")), str(body.get("symbol", "")), body.get("direction")
        volume, sl, tp = body.get("volume"), body.get("sl"), body.get("tp")
        if not sid or not symbol or direction not in ("BUY", "SELL") or not all(isinstance(x, (int, float)) and x > 0 for x in (volume, sl, tp)):
            return {"status": "REJECTED", "comment": "INVALID_REQUEST", "ticket": None, "price": None, "retcode": None}
        if self._signal_seen(sid):
            return {"status": "REJECTED", "comment": "DUPLICATE_SIGNAL", "ticket": None, "price": None, "retcode": None}
        n = self._n
        n.symbol_select(symbol, True)
        tick = n.symbol_info_tick(symbol)
        if tick is None:
            return {"status": "ERROR", "comment": "NO_TICK", "ticket": None, "price": None, "retcode": None}
        price = float(tick.ask if direction == "BUY" else tick.bid)
        req = {
            "action": n.TRADE_ACTION_DEAL, "symbol": symbol, "volume": float(volume),
            "type": n.ORDER_TYPE_BUY if direction == "BUY" else n.ORDER_TYPE_SELL,
            "price": price, "sl": float(sl), "tp": float(tp), "deviation": DEVIATION_POINTS, "magic": MAGIC,
            "comment": sid[:31], "type_time": n.ORDER_TIME_GTC, "type_filling": n.ORDER_FILLING_IOC,
        }
        chk = n.order_check(req)
        if chk is None or int(chk.retcode) != 0:
            return {"status": "REJECTED", "comment": f"ORDER_CHECK {getattr(chk, 'comment', n.last_error())}", "ticket": None, "price": None, "retcode": getattr(chk, "retcode", None)}
        res = n.order_send(req)
        if res is None:
            return {"status": "ERROR", "comment": f"ORDER_SEND {n.last_error()}", "ticket": None, "price": None, "retcode": None}
        ok = int(res.retcode) == n.TRADE_RETCODE_DONE
        return {"status": "FILLED" if ok else "REJECTED", "ticket": int(res.order) if ok else None,
                "price": float(res.price) if ok else None, "retcode": int(res.retcode), "comment": str(res.comment)}
