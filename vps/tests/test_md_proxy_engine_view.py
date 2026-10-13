"""Engine analysis view: allowlisted reads only, account/journal stripped, sensitive routes never reach 8090."""
import json
import unittest

from md_proxy import proxy as P

ORIGIN = "https://ai-trading-os.lovable.app"
H = {"origin": ORIGIN}


def env(data):
    return json.dumps({"schema": "engine-host-v1", "source": "ENGINE_HOST", "generated_at": 1, "data": data}).encode()


class Rec:
    def __init__(self, body=b"{}", status=200):
        self.calls, self.body, self.status = [], body, status

    def __call__(self, p):
        self.calls.append(p)
        return self.status, self.body


def call(target, eng, method="GET", md=None):
    md = md or Rec()
    return P.handle(method, target, H, md, frozenset({ORIGIN}), None, None, eng), md


BUNDLE = {"symbol": "XAUUSD", "source": "ENGINE_HOST", "timestamp": 5, "slice": {"x": 1}, "radar": {"snapshot": None, "health": None},
          "account": {"balance": 10000, "equity": 9999}, "trades": [{"tradeId": "t1"}], "live": None, "last_m5_close": 3,
          "health": {"symbol": "XAUUSD", "state": "ONLINE", "error": "login 123 failed", "restarts": 0}}


class EngineView(unittest.TestCase):
    def test_snapshot_strips_account_and_trades(self):
        eng = Rec(env({"bundles": [BUNDLE, dict(BUNDLE, symbol="EURUSD")]}))
        r, md = call("/v1/engine/snapshot", eng)
        self.assertEqual(r.status, 200)
        self.assertEqual(eng.calls, ["/v1/engine/snapshot"]); self.assertEqual(md.calls, [])
        b = json.loads(r.body)["data"]["bundles"]
        self.assertEqual(len(b), 1)
        self.assertIsNone(b[0]["account"]); self.assertEqual(b[0]["trades"], [])
        self.assertIsNone(b[0]["health"]["error"])
        self.assertNotIn(b"balance", r.body); self.assertNotIn(b"t1", r.body); self.assertNotIn(b"login", r.body)

    def test_health_drops_build_and_shadow(self):
        eng = Rec(env({"operating_mode": "DEMO", "execution_enabled": True, "build": {"commit": "abc"}, "shadow": {"x": 1},
                       "symbols": [{"symbol": "BTCUSD", "state": "ONLINE"}]}))
        r, _ = call("/v1/engine/health", eng)
        d = json.loads(r.body)["data"]
        self.assertEqual(set(d), {"operating_mode", "execution_enabled", "symbols"})
        self.assertEqual(d["symbols"][0]["symbol"], "BTCUSD")

    def test_snr_symbol_allowlist(self):
        eng = Rec(env({"symbol": "XAUUSD", "zones": []}))
        self.assertEqual(call("/v1/analysis/snr/XAUUSD", eng)[0].status, 200)
        self.assertEqual(call("/v1/analysis/snr/EURUSD", eng)[0].status, 403)

    def test_sensitive_engine_routes_rejected_before_upstream(self):
        eng = Rec(env({}))
        for p in ("/v1/engine/account", "/v1/engine/journal", "/v1/engine/demo", "/v1/engine/execution-status",
                  "/v1/engine/pipeline", "/v1/engine/shadow", "/v1/engine/readiness", "/v1/engine/monitoring",
                  "/v1/engine/events", "/v1/engine/XAUUSD/account", "/v1/engine/XAUUSD/journal", "/v1/journal/status",
                  "/v1/demo/account", "/v1/demo/order", "/v1/orders", "/v1/terminal", "/v1/engine/snapshot?x=1"):
            r, _ = call(p, eng)
            self.assertIn(r.status, (400, 404), p)
        self.assertEqual(eng.calls, [])

    def test_write_methods_rejected(self):
        eng = Rec(env({}))
        for m in ("POST", "PUT", "DELETE", "PATCH"):
            self.assertEqual(call("/v1/engine/snapshot", eng, m)[0].status, 405)
        self.assertEqual(eng.calls, [])

    def test_invalid_or_failed_upstream_never_passthrough(self):
        self.assertEqual(call("/v1/engine/snapshot", Rec(b'{"balance":1}'))[0].status, 502)
        self.assertEqual(call("/v1/engine/snapshot", Rec(b"x", 500))[0].status, 503)

    def test_disabled_when_no_engine_fetch(self):
        self.assertEqual(call("/v1/engine/snapshot", None)[0].status, 404)


if __name__ == "__main__":
    unittest.main()
