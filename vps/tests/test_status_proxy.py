import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from status_proxy import proxy  # noqa: E402

SENSITIVE = {"balance": 10000, "equity": 9999, "login": 464032905, "server": "Exness-MT5Trial",
             "positions": [{"price": 2300, "volume": 0.1}], "journal": [1], "token": "x"}


def fake_reader(path):
    if path == "/v1/engine/execution-status":
        return {"engine": "ONLINE", "mode": "DEMO_EXECUTION", "execution": "WAITING_SIGNAL", "mt5": "CONNECTED",
                "shadow": "CLEAR", "signal": "WAITING", "stale": False, "kill_switch": False,
                "automation": {"phase": "WAITING_SETUP", "stage": "WAITING_SETUP"},
                "blockers": ["NO_SETUP", "bad blocker with account 464032905"], "checked_at": 1, **SENSITIVE}
    if path == "/v1/health":
        return {"symbols": [{"symbol": "XAUUSD", "bid": 1}, {"symbol": "BTCUSD"}, {"symbol": "EURUSD"}], **SENSITIVE}
    return None


class StatusProxyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        proxy.read_upstream_orig = proxy.read_upstream
        proxy.build_status.__defaults__ = (fake_reader, None)
        cls.srv = proxy.ThreadingHTTPServer(("127.0.0.1", 0), proxy.Handler)
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def req(self, path, method="GET"):
        try:
            with urllib.request.urlopen(urllib.request.Request(self.base + path, method=method)) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    def test_status_is_minimal(self):
        code, body = self.req("/v1/public/engine-status")
        self.assertEqual(code, 200)
        d = json.loads(body)
        self.assertEqual(d["status"], "ONLINE")
        self.assertEqual(d["snapshot"]["phase"], "WAITING_SETUP")
        self.assertEqual(d["snapshot"]["blockers"], ["NO_SETUP"])
        self.assertEqual(d["snapshot"]["symbols"], ["XAUUSD", "BTCUSD"])
        for word in ("balance", "equity", "login", "server", "positions", "price", "volume", "journal",
                     "token", "464032905", "Exness", "10000"):
            self.assertNotIn(word, body)

    def test_health(self):
        self.assertEqual(self.req("/v1/health"), (200, '{"ok": true}'))

    def test_sensitive_routes_denied(self):
        for p in ("/v1/engine/execution-status", "/v1/demo/account", "/v1/demo/positions", "/v1/journal",
                  "/v1/account", "/v1/orders", "/v1/demo/order", "/v1/public/engine-status?x=1", "/../v1/health",
                  "/v1/ticks/latest/XAUUSD", "/"):
            self.assertEqual(self.req(p)[0], 404, p)

    def test_methods_denied(self):
        for m in ("POST", "PUT", "DELETE", "PATCH"):
            self.assertEqual(self.req("/v1/public/engine-status", m)[0], 405, m)

    def test_upstream_fixed(self):
        self.assertEqual(proxy.UPSTREAM, "http://127.0.0.1:8090")
        self.assertEqual(proxy.BIND, "127.0.0.1")
        self.assertIsNone(proxy.read_upstream_orig("/v1/demo/account"))

    def test_offline_when_unreachable(self):
        d = proxy.build_status(reader=lambda p: None, now_ms=5)
        self.assertEqual(d["status"], "OFFLINE")
        self.assertIsNone(d["heartbeat_at"])


if __name__ == "__main__":
    unittest.main()
