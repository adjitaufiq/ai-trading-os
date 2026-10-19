"""Demo execution service. Every call re-validates the account identity (DEMO + login + server whitelist)
before touching anything; any other account refuses with ACCOUNT_BLOCKED. Orders carry a fixed magic number
and the signal_id as comment; a signal_id already seen (open position or history) is refused (DUPLICATE_SIGNAL)."""
from __future__ import annotations

import sys
import time
from typing import Any, Callable, Dict, FrozenSet, Optional

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


def _f(o: Any, k: str) -> Optional[float]:
    v = getattr(o, k, None)
    return float(v) if isinstance(v, (int, float)) else None


def _stderr_log(msg: str) -> None:
    print(f"[mt5-exec] {msg}", file=sys.stderr, flush=True)


def select_filling(n: Any, symbol: str) -> tuple:
    """Pick a filling mode the broker supports for this symbol: FOK > IOC > RETURN."""
    info = n.symbol_info(symbol)
    flags = int(getattr(info, "filling_mode", 0) or 0) if info is not None else 0
    if flags & int(getattr(n, "SYMBOL_FILLING_FOK", 1)):
        return n.ORDER_FILLING_FOK, "FOK"
    if flags & int(getattr(n, "SYMBOL_FILLING_IOC", 2)):
        return n.ORDER_FILLING_IOC, "IOC"
    return n.ORDER_FILLING_RETURN, "RETURN"


class DemoExecService:
    def __init__(self, native: Any, logins: FrozenSet[int], servers: FrozenSet[str], log: Callable[[str], None] = _stderr_log) -> None:
        if not logins or not servers:
            raise ValueError("demo whitelist must not be empty")
        self._n = native
        self._logins = logins
        self._servers = servers
        self._log = log

    # ---- identity binding ----
    def account(self) -> Dict[str, Any]:
        a = self._n.account_info()
        if a is None:
            raise AccountBlocked("IDENTITY_UNAVAILABLE")
        return {"login": int(a.login), "server": str(a.server), "trade_mode": _mode_name(self._n, int(a.trade_mode)),
                "balance": float(a.balance), "equity": float(a.equity), "currency": str(a.currency),
                "margin": _f(a, "margin"), "margin_free": _f(a, "margin_free"), "margin_level": _f(a, "margin_level"),
                "leverage": int(getattr(a, "leverage", 0) or 0) or None}

    def status(self) -> Dict[str, Any]:
        """Read-only connection/identity status. Never raises; EXECUTION is always DISABLED here because
        execution permission is owned by the engine host (Shadow Guard + approval), not by this service."""
        try:
            a = self.account()
        except AccountBlocked:
            return {"mt5": "DISCONNECTED", "account": "UNKNOWN", "reason": "IDENTITY_UNAVAILABLE", "execution": "DISABLED"}
        except Exception:  # noqa: BLE001
            return {"mt5": "DISCONNECTED", "account": "UNKNOWN", "reason": "TERMINAL_ERROR", "execution": "DISABLED"}
        try:
            self._require_demo()
            verdict, reason = "VERIFIED", None
        except AccountBlocked as e:
            verdict, reason = "UNKNOWN", str(e)
        return {"mt5": "CONNECTED", "account": verdict, "reason": reason, "execution": "DISABLED",
                "login": a["login"], "server": a["server"], "trade_mode": a["trade_mode"]}

    def symbols(self, names: list) -> list:
        """Availability + contract spec for several symbols (max 20). Read-only; does not select symbols."""
        self._require_demo()
        out = []
        for name in [str(x).strip() for x in names if str(x).strip()][:20]:
            s = self._n.symbol_info(name)
            if s is None:
                out.append({"name": name, "available": False})
                continue
            out.append({"name": name, "available": True, "visible": bool(getattr(s, "visible", False)),
                        "volume_min": float(s.volume_min), "volume_max": float(s.volume_max), "volume_step": float(s.volume_step),
                        "tick_size": float(s.trade_tick_size), "tick_value": float(s.trade_tick_value)})
        return out

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
        return [{"ticket": int(p.ticket), "symbol": str(p.symbol), "comment": str(p.comment),
                 "volume": _f(p, "volume"), "price_open": _f(p, "price_open"), "sl": _f(p, "sl"), "tp": _f(p, "tp"), "profit": _f(p, "profit")}
                for p in rows if int(p.magic) == MAGIC]

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

    # ---- bot-only close (daily portfolio guard) ----
    def close_position(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """Close ONE bot position: ticket must exist with our MAGIC and comment == signal_id[:31].
        Manual / unknown positions are refused. Result is verified by re-reading positions;
        anything not provably closed is UNVERIFIED (caller must fail closed)."""
        self._require_demo()
        sid = str(body.get("signal_id", ""))
        ticket = body.get("ticket")
        if not sid or not isinstance(ticket, int) or ticket <= 0:
            return {"status": "REJECTED", "comment": "INVALID_REQUEST", "ticket": ticket}
        n = self._n
        pos = next((p for p in n.positions_get() or () if int(p.ticket) == ticket), None)
        if pos is None:
            return {"status": "NOT_FOUND", "comment": "POSITION_NOT_OPEN", "ticket": ticket}
        c = str(pos.comment)
        comment_ok = c == sid[:31] or (len(c) >= 8 and sid.startswith(c))  # broker may truncate comments
        if int(pos.magic) != MAGIC or not comment_ok:
            return {"status": "REJECTED", "comment": "NOT_BOT_POSITION", "ticket": ticket}
        symbol = str(pos.symbol)
        tick = n.symbol_info_tick(symbol)
        if tick is None:
            return {"status": "ERROR", "comment": "NO_TICK", "ticket": ticket}
        is_buy = int(getattr(pos, "type", 0)) == n.ORDER_TYPE_BUY
        filling, _ = select_filling(n, symbol)
        req = {"action": n.TRADE_ACTION_DEAL, "symbol": symbol, "volume": float(pos.volume), "position": ticket,
               "type": n.ORDER_TYPE_SELL if is_buy else n.ORDER_TYPE_BUY,
               "price": float(tick.bid if is_buy else tick.ask), "deviation": DEVIATION_POINTS, "magic": MAGIC,
               "comment": sid[:31], "type_time": n.ORDER_TIME_GTC, "type_filling": filling}
        res = n.order_send(req)
        self._log(f"close ticket={ticket} retcode={getattr(res, 'retcode', None)}")
        if res is None or int(res.retcode) != n.TRADE_RETCODE_DONE:
            return {"status": "REJECTED", "comment": f"ORDER_SEND {getattr(res, 'comment', n.last_error())}", "ticket": ticket, "retcode": getattr(res, "retcode", None)}
        still = [p for p in n.positions_get() or () if int(p.ticket) == ticket]
        if still:
            return {"status": "UNVERIFIED", "comment": "POSITION_STILL_OPEN", "ticket": ticket, "remaining_volume": _f(still[0], "volume")}
        return {"status": "CLOSED", "comment": str(res.comment), "ticket": ticket, "price": float(res.price), "retcode": int(res.retcode)}

    # ---- open order ----
    def send_order(self, body: Dict[str, Any]) -> Dict[str, Any]:
        res = self._send_order(body)
        res.update({"symbol": str(body.get("symbol", "")), "direction": body.get("direction"),
                    "timestamp": int(time.time() * 1000)})
        res.setdefault("volume", None)
        res["error"] = None if res["status"] == "FILLED" else res.get("comment")
        return res

    def _send_order(self, body: Dict[str, Any]) -> Dict[str, Any]:
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
        filling, filling_name = select_filling(n, symbol)
        req = {
            "action": n.TRADE_ACTION_DEAL, "symbol": symbol, "volume": float(volume),
            "type": n.ORDER_TYPE_BUY if direction == "BUY" else n.ORDER_TYPE_SELL,
            "price": price, "sl": float(sl), "tp": float(tp), "deviation": DEVIATION_POINTS, "magic": MAGIC,
            "comment": sid[:31], "type_time": n.ORDER_TIME_GTC, "type_filling": filling,
        }
        chk = n.order_check(req)
        self._log(f"symbol={symbol} filling={filling_name} order_check_retcode={getattr(chk, 'retcode', None)}")
        if chk is None or int(chk.retcode) != 0:
            return {"status": "REJECTED", "comment": f"ORDER_CHECK {getattr(chk, 'comment', n.last_error())}", "ticket": None, "price": None, "retcode": getattr(chk, "retcode", None)}
        res = n.order_send(req)
        self._log(f"symbol={symbol} filling={filling_name} order_send_retcode={getattr(res, 'retcode', None)}")
        if res is None:
            return {"status": "ERROR", "comment": f"ORDER_SEND {n.last_error()}", "ticket": None, "price": None, "retcode": None}
        ok = int(res.retcode) == n.TRADE_RETCODE_DONE
        return {"status": "FILLED" if ok else "REJECTED", "ticket": int(res.order) if ok else None,
                "price": float(res.price) if ok else None, "volume": float(getattr(res, "volume", volume)) if ok else None, "retcode": int(res.retcode), "comment": str(res.comment)}
