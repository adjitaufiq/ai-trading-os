import unittest
from types import SimpleNamespace as NS

from mt5_exec.native_exec import ExecCapabilityDenied, WhitelistedExecNative
from mt5_exec.service import MAGIC, AccountBlocked, DemoExecService


class FakeExec:
    ACCOUNT_TRADE_MODE_DEMO, ACCOUNT_TRADE_MODE_CONTEST, ACCOUNT_TRADE_MODE_REAL = 0, 1, 2
    TRADE_ACTION_DEAL, ORDER_TYPE_BUY, ORDER_TYPE_SELL, ORDER_TIME_GTC = 1, 0, 1, 0
    ORDER_FILLING_FOK, ORDER_FILLING_IOC, ORDER_FILLING_RETURN = 0, 1, 2
    SYMBOL_FILLING_FOK, SYMBOL_FILLING_IOC = 1, 2
    filling_flags = 1
    TRADE_RETCODE_DONE, DEAL_ENTRY_OUT, DEAL_REASON_SL, DEAL_REASON_TP = 10009, 1, 4, 5

    def __init__(self, mode=0, login=111, server="Exness-MT5Trial"):
        self.acct = NS(login=login, server=server, trade_mode=mode, balance=10000.0, equity=10000.0, currency="USD")
        self.sent, self.pos, self.deals = [], [], []

    def account_info(self): return self.acct
    def last_error(self): return (0, "ok")
    def symbol_select(self, *_): return True
    def symbol_info(self, _): return NS(filling_mode=self.filling_flags)
    def symbol_info_tick(self, _): return NS(bid=2000.0, ask=2000.2)
    def order_check(self, _): return NS(retcode=0, comment="ok")
    def positions_get(self): return tuple(self.pos)
    def history_deals_get(self, *a, **k): return tuple(self.deals)

    def order_send(self, req):
        self.sent.append(req)
        self.pos.append(NS(ticket=7, symbol=req["symbol"], comment=req["comment"], magic=req["magic"]))
        return NS(retcode=10009, order=7, price=2000.2, comment="done")

    def order_close_all(self): raise AssertionError("must be unreachable")


ORDER = {"signal_id": "sig1", "symbol": "XAUUSD", "direction": "BUY", "volume": 0.1, "sl": 1995.0, "tp": 2010.0}


class DemoExecTests(unittest.TestCase):
    def svc(self, fake):
        return DemoExecService(fake, frozenset({111}), frozenset({"Exness-MT5Trial"}), log=lambda _m: None)

    def test_real_account_blocked(self):
        f = FakeExec(mode=2)
        with self.assertRaises(AccountBlocked):
            self.svc(f).send_order(ORDER)
        self.assertEqual(f.sent, [])

    def test_unknown_login_and_server_blocked(self):
        for f in (FakeExec(login=5), FakeExec(server="Exness-MT5Real")):
            with self.assertRaises(AccountBlocked):
                self.svc(f).send_order(ORDER)
            self.assertEqual(f.sent, [])

    def test_demo_fill_and_duplicate(self):
        f = FakeExec()
        r = self.svc(f).send_order(ORDER)
        self.assertEqual(r["status"], "FILLED")
        self.assertEqual(f.sent[0]["magic"], MAGIC)
        self.assertEqual(self.svc(f).send_order(ORDER)["comment"], "DUPLICATE_SIGNAL")
        self.assertEqual(len(f.sent), 1)

    def test_filling_mode_selection(self):
        for flags, want in ((3, 0), (2, 1), (0, 2)):
            f = FakeExec(); f.filling_flags = flags
            self.assertEqual(self.svc(f).send_order(ORDER)["status"], "FILLED")
            self.assertEqual(f.sent[0]["type_filling"], want)

    def test_status_read_only(self):
        f = FakeExec()
        st = self.svc(f).status()
        self.assertEqual((st["mt5"], st["account"], st["execution"]), ("CONNECTED", "VERIFIED", "DISABLED"))
        self.assertEqual(self.svc(FakeExec(mode=2)).status()["account"], "UNKNOWN")
        f.account_info = lambda: None
        self.assertEqual(self.svc(f).status()["mt5"], "DISCONNECTED")
        self.assertEqual(f.sent, [])

    def test_symbols_and_margin(self):
        f = FakeExec()
        f.acct.margin, f.acct.margin_free, f.acct.margin_level = 10.0, 9990.0, 100000.0
        f.symbol_info = lambda n: None if n == "NOPE" else NS(volume_min=0.01, volume_max=100.0, volume_step=0.01, trade_tick_size=0.01, trade_tick_value=1.0, visible=True)
        rows = self.svc(f).symbols(["XAUUSD", "NOPE", ""])
        self.assertEqual([(r["name"], r["available"]) for r in rows], [("XAUUSD", True), ("NOPE", False)])
        self.assertEqual(self.svc(f).account()["margin_free"], 9990.0)
        with self.assertRaises(AccountBlocked):
            self.svc(FakeExec(mode=2)).symbols(["XAUUSD"])
        self.assertEqual(f.sent, [])

    def test_close_bot_only_and_verified(self):
        f = FakeExec()
        f.pos = [NS(ticket=9, symbol="XAUUSD", comment="manual", magic=0, volume=0.1, type=0),
                 NS(ticket=8, symbol="XAUUSD", comment="sig1", magic=MAGIC, volume=0.1, type=0)]
        s = self.svc(f)
        self.assertEqual(s.close_position({"ticket": 9, "signal_id": "manual"})["comment"], "NOT_BOT_POSITION")
        self.assertEqual(s.close_position({"ticket": 8, "signal_id": "other"})["comment"], "NOT_BOT_POSITION")
        self.assertEqual(f.sent, [])
        f.order_send = lambda req: (f.sent.append(req), f.pos.remove(f.pos[1]), NS(retcode=10009, price=1999.0, comment="done"))[2]
        r = s.close_position({"ticket": 8, "signal_id": "sig1"})
        self.assertEqual(r["status"], "CLOSED")
        self.assertEqual((f.sent[0]["position"], f.sent[0]["type"]), (8, f.ORDER_TYPE_SELL))
        self.assertEqual(len(f.pos), 1)  # manual position untouched

    def test_close_unverified_and_real_blocked(self):
        f = FakeExec()
        f.pos = [NS(ticket=8, symbol="XAUUSD", comment="sig1", magic=MAGIC, volume=0.1, type=0)]
        f.order_send = lambda req: NS(retcode=10009, price=1999.0, comment="done")  # broker says done but pos remains
        self.assertEqual(self.svc(f).close_position({"ticket": 8, "signal_id": "sig1"})["status"], "UNVERIFIED")
        with self.assertRaises(AccountBlocked):
            self.svc(FakeExec(mode=2)).close_position({"ticket": 8, "signal_id": "sig1"})

    def test_whitelist_proxy(self):
        p = WhitelistedExecNative(FakeExec())
        with self.assertRaises(ExecCapabilityDenied):
            p.order_close_all  # noqa: B018
        with self.assertRaises(ValueError):
            DemoExecService(FakeExec(), frozenset(), frozenset({"x"}))


if __name__ == "__main__":
    unittest.main()
