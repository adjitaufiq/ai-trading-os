"""Loopback-only HTTP transport for the demo execution service. Static route table, bearer token required.
Never expose this port through a tunnel; only the local engine host calls it.

Run on the Windows VPS (same pre-authenticated MT5 terminal, logged into the DEMO account):
  set DEMO_EXEC_TOKEN=...  set DEMO_ACCOUNT_WHITELIST=12345678  set DEMO_SERVER_WHITELIST=Exness-MT5Trial
  python -m vps.mt5_exec.server
"""
from __future__ import annotations

import hmac
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional
from urllib.parse import parse_qs, urlparse

from .service import AccountBlocked, DemoExecService

HOST = "127.0.0.1"
_LOG_LOCK = threading.Lock()


def log_event(path: str, event: dict) -> None:
    """Append-only JSONL execution log (request + broker response + latency) for the engine journal."""
    with _LOG_LOCK, open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(event) + "\n")


def make_handler(svc: DemoExecService, token: str, log_path: str = "demo-exec.log.jsonl") -> type:
    class H(BaseHTTPRequestHandler):
        def log_message(self, *_: Any) -> None:  # quiet
            pass

        def _send(self, code: int, body: Any) -> None:
            raw = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _auth(self) -> bool:
            got = self.headers.get("authorization", "")
            if not hmac.compare_digest(got.encode(), f"Bearer {token}".encode()):
                self._send(401, {"error": "UNAUTHORIZED"})
                return False
            return True

        def _run(self, fn: Callable[[], Any]) -> None:
            try:
                self._send(200, fn())
            except AccountBlocked as e:
                self._send(403, {"error": "ACCOUNT_BLOCKED", "reason": str(e)})
            except Exception as e:  # noqa: BLE001
                self._send(500, {"error": "INTERNAL", "detail": str(e)})

        def do_GET(self) -> None:  # noqa: N802
            if not self._auth():
                return
            u = urlparse(self.path)
            q = parse_qs(u.query)
            if u.path == "/v1/demo/account":
                return self._run(svc.account)
            if u.path == "/v1/demo/status":
                return self._run(svc.status)
            if u.path == "/v1/demo/symbols":
                return self._run(lambda: {"symbols": svc.symbols(",".join(q.get("names", [""])).split(","))})
            if u.path == "/v1/demo/positions":
                return self._run(lambda: {"positions": svc.positions()})
            if u.path == "/v1/demo/symbol":
                return self._run(lambda: svc.symbol(q.get("name", [""])[0]) or {"error": "NOT_FOUND"})
            if u.path == "/v1/demo/close-deal":
                return self._run(lambda: svc.close_deal(int(q.get("position", ["0"])[0])) or {"error": "NOT_FOUND"})
            self._send(404, {"error": "NOT_FOUND"})

        def do_POST(self) -> None:  # noqa: N802
            if not self._auth():
                return
            if urlparse(self.path).path != "/v1/demo/orders":
                return self._send(404, {"error": "NOT_FOUND"})
            n = int(self.headers.get("content-length", "0") or 0)
            try:
                body = json.loads(self.rfile.read(min(n, 4096)) or b"{}")
            except ValueError:
                return self._send(400, {"error": "BAD_JSON"})
            req = body if isinstance(body, dict) else {}
            t0 = time.time()
            def go() -> Any:
                res = svc.send_order(req)
                try:
                    log_event(log_path, {"type": "DEMO_ORDER", "at": int(t0 * 1000), "latency_ms": int((time.time() - t0) * 1000), "request": req, "response": res})
                except OSError:
                    pass
                return res
            self._run(go)

    return H


def main(native: Optional[Any] = None) -> None:  # pragma: no cover - VPS entry
    token = os.environ.get("DEMO_EXEC_TOKEN", "")
    if len(token) < 24:
        raise SystemExit("DEMO_EXEC_TOKEN (>=24 chars) required")
    logins = frozenset(int(x) for x in os.environ.get("DEMO_ACCOUNT_WHITELIST", "").split(",") if x.strip().isdigit())
    servers = frozenset(x.strip() for x in os.environ.get("DEMO_SERVER_WHITELIST", "").split(",") if x.strip())
    if native is None:
        from .native_exec import load_exec_native
        native = load_exec_native()
        if not native.initialize():
            raise SystemExit(f"MT5 initialize failed: {native.last_error()}")
    svc = DemoExecService(native, logins, servers)
    svc._require_demo()  # refuse to start on a non-demo / non-whitelisted account
    port = int(os.environ.get("DEMO_EXEC_PORT", "8100"))
    print(f"[mt5-exec] DEMO execution gateway on http://{HOST}:{port}")
    ThreadingHTTPServer((HOST, port), make_handler(svc, token, os.environ.get("DEMO_EXEC_LOG", "demo-exec.log.jsonl"))).serve_forever()


if __name__ == "__main__":  # pragma: no cover
    main()
