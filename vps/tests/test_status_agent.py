"""Status agent: allowlist sanitization, signing, https-only, no redirects."""
import hashlib
import hmac
import json
import unittest

from status_agent import agent as A

EXEC = {
    "schema": "engine-execution-status-v1", "engine": "ONLINE", "mode": "DEMO_EXECUTION", "execution": "WAITING_SIGNAL",
    "account": "PASS", "mt5": "CONNECTED", "shadow": "CLEAR", "kill_switch": False, "risk": "UNKNOWN",
    "reconciliation": "CLEAN", "signal": "WAITING", "stale": False, "blockers": ["NO_SETUP", "bad blocker 1.2345", "x" * 80],
    "checked_at": 1700000000000,
    "automation": {"stage": "DEMO_ARMED", "phase": "WAITING_SETUP", "checklist": [{"id": "account", "detail": "login 464032905"}], "transitions": []},
    "balance": 10000, "equity": 9999, "login": 464032905, "server": "Exness-MT5Trial17",
    "positions": [{"entry": 2400.5, "sl": 2390, "tp": 2420, "volume": 0.01}],
}
HEALTH = {"symbols": [{"symbol": "XAUUSD", "balance": 1}, {"symbol": "BTCUSD"}, {"symbol": "EURUSD"}]}
SENSITIVE = ("balance", "equity", "login", "server", "positions", "464032905", "Exness", "2400.5", "volume", "checklist", "account", "risk")


class Sanitize(unittest.TestCase):
    def test_allowlist_only(self):
        s = A.sanitize(EXEC, HEALTH, 1)
        blob = json.dumps(s)
        for word in SENSITIVE:
            self.assertNotIn(word, blob, word)
        self.assertEqual(s["phase"], "WAITING_SETUP")
        self.assertEqual(s["blockers"], ["NO_SETUP"])
        self.assertEqual(s["symbols"], ["XAUUSD", "BTCUSD"])
        self.assertTrue(s["engine_reachable"])
        self.assertEqual(set(s), {"schema", "engine", "mode", "execution", "mt5", "shadow", "kill_switch", "signal", "stale",
                                  "phase", "stage", "blockers", "symbols", "engine_checked_at", "engine_reachable"})

    def test_unreachable_is_fail_closed(self):
        s = A.sanitize(None, None, 5)
        self.assertEqual((s["engine"], s["shadow"], s["stale"], s["engine_reachable"]), ("OFFLINE", "BLOCKING", True, False))

    def test_unknown_enum_values_dropped(self):
        s = A.sanitize({**EXEC, "engine": "HACKED", "automation": {"phase": "<script>"}}, None, 1)
        self.assertEqual((s["engine"], s["phase"]), ("OFFLINE", None))


class Push(unittest.TestCase):
    def test_signature_matches_backend_canonical(self):
        sig = A.sign("k", "123", "post", "/p", "{}")
        self.assertEqual(sig, hmac.new(b"k", b"123\nPOST\n/p\n{}", hashlib.sha256).hexdigest())

    def test_https_only(self):
        with self.assertRaises(ValueError):
            A.push("http://example.com", "k", "a", {}, 1)

    def test_signed_request_shape(self):
        seen = {}

        class R:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *a): return False

        class Op:
            def open(self, req, timeout):
                seen["req"] = req
                return R()

        self.assertEqual(A.push("https://relay.example", "k", "vps-1", {"a": 1}, 42, opener=Op()), 200)
        req = seen["req"]
        self.assertEqual(req.full_url, "https://relay.example" + A.RELAY_PATH)
        body = req.data.decode()
        self.assertEqual(req.get_header("X-agent-signature"), A.sign("k", "42", "POST", A.RELAY_PATH, body))
        self.assertNotIn("k", req.get_header("X-agent-timestamp"))

    def test_no_redirect_follow(self):
        self.assertIsNone(A._NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil"))

    def test_engine_base_is_loopback(self):
        self.assertEqual(A.ENGINE_BASE, "http://127.0.0.1:8090")


if __name__ == "__main__":
    unittest.main()
