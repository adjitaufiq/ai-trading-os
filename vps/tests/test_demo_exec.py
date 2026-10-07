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

    def test_whitelist_proxy(self):
        p = WhitelistedExecNative(FakeExec())
        with self.assertRaises(ExecCapabilityDenied):
            p.order_close_all  # noqa: B018
        with self.assertRaises(ValueError):
            DemoExecService(FakeExec(), frozenset(), frozenset({"x"}))


if __name__ == "__main__":
    unittest.main()
