"""Status-only proxy (read-only, loopback). Python stdlib only.

Listens on 127.0.0.1:8782 (expose ONLY this port via its own Quick Tunnel). Serves exactly:
  GET /v1/health                 -> {"ok": true}
  GET /v1/public/engine-status   -> minimal sanitized status (same shape as the cloud relay)
Every other path -> 404, every other method -> 405. Upstream is fixed to http://127.0.0.1:8090 and
only GET /v1/health + /v1/engine/execution-status are read; raw responses are never forwarded.
The allowlist copy (status_agent.agent.sanitize) drops balance, equity, login/server, positions,
prices, volumes, journal and checklist details by construction. No secret, no write, no order path.
"""
import json
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from status_agent.agent import SCHEMA, sanitize  # noqa: E402

UPSTREAM = "http://127.0.0.1:8090"
BIND = "127.0.0.1"
PORT = int(os.environ.get("STATUS_PROXY_PORT", "8782"))
CACHE_MS = 3000
RATE_PER_MIN = 120
ORIGINS = {o.strip() for o in os.environ.get(
    "STATUS_PROXY_ORIGINS",
    "https://ai-trading-os.lovable.app,https://id-preview--b7029c13-ae79-4d40-961b-542f2d4e9f08.lovable.app",
).split(",") if o.strip()}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_opener = urllib.request.build_opener(_NoRedirect())


def read_upstream(path, timeout=5.0):
    if path not in ("/v1/health", "/v1/engine/execution-status"):
        return None
    try:
        with _opener.open(UPSTREAM + path, timeout=timeout) as r:
            if r.status != 200:
                return None
            body = json.loads(r.read(1_000_000).decode("utf-8"))
            return body.get("data") if isinstance(body, dict) else None
    except Exception:
        return None


def build_status(reader=read_upstream, now_ms=None):
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    ex = reader("/v1/engine/execution-status")
    health = reader("/v1/health")
    snap = sanitize(ex, health, now)
    online = snap["engine_reachable"] and snap["engine"] == "ONLINE"
    return {
        "schema": SCHEMA,
        "status": "ONLINE" if online else "OFFLINE",
        "heartbeat_at": now if snap["engine_reachable"] else None,
        "heartbeat_age_ms": 0 if snap["engine_reachable"] else None,
        "data": "UNKNOWN" if not snap["engine_reachable"] else ("STALE" if snap["stale"] else "FRESH"),
        "snapshot": snap,
    }


_lock = threading.Lock()
_cache = {"at": 0, "body": None}
_hits = {}


def cached_status():
    now = int(time.time() * 1000)
    with _lock:
        if _cache["body"] is None or now - _cache["at"] > CACHE_MS:
            _cache["body"] = json.dumps(build_status(now_ms=now)).encode("utf-8")
            _cache["at"] = now
        return _cache["body"]


def rate_ok(ip):
    minute = int(time.time() // 60)
    with _lock:
        k = (ip, minute)
        _hits[k] = _hits.get(k, 0) + 1
        for old in [x for x in _hits if x[1] < minute]:
            del _hits[old]
        return _hits[k] <= RATE_PER_MIN


class Handler(BaseHTTPRequestHandler):
    server_version = "status-proxy"
    sys_version = ""

    def _send(self, code, body):
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self.headers.get("Origin")
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        ip = self.headers.get("CF-Connecting-IP") or self.client_address[0]
        if not rate_ok(ip):
            return self._send(429, {"error": "RATE_LIMITED"})
        path = self.path
        if path == "/v1/health":
            return self._send(200, {"ok": True})
        if path == "/v1/public/engine-status":
            return self._send(200, cached_status())
        return self._send(404, {"error": "NOT_FOUND"})

    def _deny(self):
        self._send(405, {"error": "METHOD_NOT_ALLOWED"})

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_HEAD = _deny

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.command, self.path.split("?")[0][:80]))


def main():
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"status-proxy listening on http://{BIND}:{PORT} -> {UPSTREAM} (status only)")
    srv.serve_forever()


if __name__ == "__main__":
    main()
