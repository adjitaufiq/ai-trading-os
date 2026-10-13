"""Read-only market-data proxy: allowlist passes, everything else rejected before upstream."""
import json
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from md_proxy import proxy as P

ORIGIN = "https://ai-trading-os.lovable.app"
ORIGINS = frozenset({ORIGIN})
OK_HDR = {"origin": ORIGIN, "cf-access-jwt-assertion": "x"}


class Recorder:
    def __init__(self, status=200, body=b'{"ok":true}', exc=None):
        self.calls, self.status, self.body, self.exc = [], status, body, exc

    def __call__(self, path):
        self.calls.append(path)
        if self.exc:
            raise self.exc
        return self.status, self.body


def run(method, target, headers=None, fetch=None, require=True):
    f = fetch or Recorder()
    return P.handle(method, target, OK_HDR if headers is None else headers, f, ORIGINS, require), f


class Allowed(unittest.TestCase):
    def test_allowlisted_routes_forward_rebuilt_path(self):
        cases = {
            "/v1/health": "/v1/health",
            "/v1/ticks/latest/XAUUSD": "/v1/ticks/latest/XAUUSD",
            "/v1/ticks/latest/BTCUSD": "/v1/ticks/latest/BTCUSD",
            "/v1/symbols/XAUUSD": "/v1/symbols/XAUUSD",
            "/v1/symbols/BTCUSD": "/v1/symbols/BTCUSD",
            "/v1/bars/XAUUSD/M5?mode=pos&start=0&count=200": "/v1/bars/XAUUSD/M5?mode=pos&start=0&count=200",
            "/v1/bars/BTCUSD/H4?count=300&start=0&mode=pos": "/v1/bars/BTCUSD/H4?mode=pos&start=0&count=300",
        }
        for tf in ("M15", "H1"):
            cases[f"/v1/bars/XAUUSD/{tf}?mode=pos&start=0&count=1"] = f"/v1/bars/XAUUSD/{tf}?mode=pos&start=0&count=1"
        for target, upstream in cases.items():
            res, f = run("GET", target)
            self.assertEqual(res.status, 200, target)
            self.assertEqual(f.calls, [upstream])
            self.assertIn(("Access-Control-Allow-Origin", ORIGIN), res.headers)

    def test_preflight_no_upstream(self):
        res, f = run("OPTIONS", "/v1/health", {"origin": ORIGIN})
        self.assertEqual((res.status, f.calls), (204, []))

    def test_upstream_status_passthrough(self):
        res, _ = run("GET", "/v1/health", fetch=Recorder(status=503, body=b'{"e":1}'))
        self.assertEqual((res.status, res.body), (503, b'{"e":1}'))


class Rejected(unittest.TestCase):
    def assertRejected(self, method, target, status, headers=None):
        res, f = run(method, target, headers)
        self.assertEqual(res.status, status, f"{method} {target}")
        self.assertEqual(f.calls, [], f"upstream called for {method} {target}")

    def test_methods(self):
        for m in ("POST", "PUT", "PATCH", "DELETE", "HEAD", "CONNECT", "TRACE"):
            self.assertRejected(m, "/v1/health", 405)

    def test_non_allowlisted_paths(self):
        for t in ("/", "/v1", "/v1/terminal", "/v1/symbols", "/v1/symbols?group=*", "/v1/ticks/XAUUSD?mode=from&from=x&count=1",
                  "/v1/stream", "/v1/demo/orders", "/v1/demo/account", "/v1/demo/status", "/v1/demo/positions",
                  "/v1/orders", "/v1/account", "/v1/engine/health", "/v1/engine/account", "/v2/health",
                  "/v1/health/", "//v1/health", "/v1/../v1/health", "/v1/%74erminal", "/v1/ticks/latest/XAUUSD/x",
                  "http://127.0.0.1:8100/v1/demo/orders", "/v1/health\\x"):
            res, f = run("GET", t)
            self.assertIn(res.status, (400, 403, 404), t)
            self.assertEqual(f.calls, [], t)

    def test_symbols(self):
        for s in ("EURUSD", "xauusd", "XAUUSD.m", "BTC", "XAUUSD%00", ""):
            for t in (f"/v1/ticks/latest/{s}", f"/v1/symbols/{s}", f"/v1/bars/{s}/M5?mode=pos&start=0&count=1"):
                res, f = run("GET", t)
                self.assertIn(res.status, (403, 404), t)
                self.assertEqual(f.calls, [])

    def test_timeframes(self):
        for tf in ("M1", "M30", "D1", "m5", "W1"):
            self.assertRejected("GET", f"/v1/bars/XAUUSD/{tf}?mode=pos&start=0&count=1", 400)

    def test_bar_query(self):
        base = "/v1/bars/XAUUSD/M5"
        for q in ("", "?", "?mode=pos", "?mode=pos&start=0", "?mode=from&from=2026-01-01T00:00:00Z&count=1",
                  "?mode=range&from=a&to=b", "?mode=pos&start=0&count=0", "?mode=pos&start=0&count=501",
                  "?mode=pos&start=1001&count=1", "?mode=pos&start=-1&count=1", "?mode=pos&start=0&count=1&x=1",
                  "?mode=pos&start=0&start=1&count=1", "?mode=pos&start=0x1&count=1", "?mode=pos&start=0&count=1e2"):
            self.assertRejected("GET", base + q, 400)

    def test_query_on_fixed_routes(self):
        for t in ("/v1/health?x=1", "/v1/ticks/latest/XAUUSD?count=5", "/v1/symbols/BTCUSD?group=*"):
            self.assertRejected("GET", t, 400)

    def test_oversized(self):
        self.assertRejected("GET", "/v1/" + "a" * 300, 400)

    def test_origin_not_allowed(self):
        for o in ("https://evil.example", "null", "http://ai-trading-os.lovable.app"):
            self.assertRejected("GET", "/v1/health", 403, {"origin": o, "cf-access-jwt-assertion": "x"})

    def test_access_required(self):
        self.assertRejected("GET", "/v1/health", 401, {"origin": ORIGIN})
        res, f = run("GET", "/v1/health", {"origin": ORIGIN}, require=False)
        self.assertEqual(res.status, 200)

    def test_upstream_failures_sanitized(self):
        res, _ = run("GET", "/v1/health", fetch=Recorder(exc=TimeoutError("secret detail")))
        self.assertEqual((res.status, json.loads(res.body)), (504, {"error": "UPSTREAM_UNAVAILABLE"}))
        res, _ = run("GET", "/v1/health", fetch=Recorder(exc=OverflowError()))
        self.assertEqual(res.status, 502)


class Config(unittest.TestCase):
    def test_origin_parsing_strict(self):
        o = P.parse_origins(" https://a.app ,*,http://b.app,https://*.c.app,https://d.app/path, ")
        self.assertEqual(o, frozenset({"https://a.app"}))
        self.assertEqual(P.parse_origins(None), frozenset())

    def test_upstream_loopback_only(self):
        for bad in ("http://10.0.0.1:8765", "https://127.0.0.1:8765", "http://example.com", "http://127.0.0.1.evil.com"):
            with self.assertRaises(ValueError):
                P.make_upstream_fetch(bad)
        P.make_upstream_fetch("http://127.0.0.1:8765")

    def test_bind_loopback_only(self):
        with self.assertRaises(ValueError):
            P.build_server("0.0.0.0", 0, Recorder(), ORIGINS, True)

    def test_no_execution_surface_in_source(self):
        src = (Path(P.__file__)).read_text(encoding="utf8")
        for forbidden in ("8100", "DEMO_EXEC_TOKEN", "order_send", "MetaTrader5", "Authorization", "/v1/demo"):
            self.assertNotIn(forbidden, src.split('"""', 2)[2] if forbidden == "8100" else src)
        self.assertEqual([r[0] for r in P.APPROVED_ROUTES], ["GET"] * 4)


class LiveLoopback(unittest.TestCase):
    """End-to-end over real sockets against a fake upstream; size cap + header stripping."""

    def test_round_trip(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        seen = []

        class Up(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.path, {k.lower() for k in self.headers.keys()}))
                body = b"x" * (P.MAX_RESPONSE_BYTES + 10) if "BTCUSD" in self.path else b'{"tick":1}'
                self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a): pass

        up = ThreadingHTTPServer(("127.0.0.1", 0), Up)
        threading.Thread(target=up.serve_forever, daemon=True).start()
        px = P.build_server("127.0.0.1", 0, P.make_upstream_fetch(f"http://127.0.0.1:{up.server_port}"), ORIGINS, True)
        threading.Thread(target=px.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{px.server_port}"
        try:
            req = urllib.request.Request(base + "/v1/ticks/latest/XAUUSD", headers={
                "Origin": ORIGIN, "Cf-Access-Jwt-Assertion": "jwt", "Cookie": "c=1", "Authorization": "Bearer s"})
            with urllib.request.urlopen(req, timeout=5) as r:
                self.assertEqual((r.status, r.read()), (200, b'{"tick":1}'))
            self.assertEqual(seen[0][0], "/v1/ticks/latest/XAUUSD")
            self.assertTrue({"cookie", "authorization", "cf-access-jwt-assertion", "origin"}.isdisjoint(seen[0][1]))
            req = urllib.request.Request(base + "/v1/ticks/latest/BTCUSD", headers={"Origin": ORIGIN, "Cf-Access-Jwt-Assertion": "j"})
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(req, timeout=5)
            self.assertEqual(cm.exception.code, 502)
            req = urllib.request.Request(base + "/v1/demo/orders", data=b"{}", method="POST", headers={"Origin": ORIGIN})
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(req, timeout=5)
            self.assertEqual(cm.exception.code, 405)
            self.assertEqual(len(seen), 2)
        finally:
            px.shutdown(); up.shutdown()


if __name__ == "__main__":
    unittest.main()
