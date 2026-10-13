"""Read-only market-data proxy in front of the loopback MT5 gateway (default 127.0.0.1:8765).

Stdlib only. Static allowlist — NOT a generic forwarder:
  GET /v1/health
  GET /v1/ticks/latest/{XAUUSD|BTCUSD}
  GET /v1/symbols/{XAUUSD|BTCUSD}
  GET /v1/bars/{XAUUSD|BTCUSD}/{M5|M15|H1|H4}?mode=pos&start=<0..1000>&count=<1..500>
  OPTIONS on the same paths (CORS preflight, allowlisted origins only)
Everything else -> 404/405/400 before any upstream call. The upstream path is rebuilt from
validated values; the client's raw path/query is never forwarded. No request headers, cookies or
credentials are forwarded upstream. The proxy has no route to the demo execution service (8100).

Auth design: the proxy binds loopback only and is meant to be reached exclusively through a
Cloudflare named tunnel protected by Cloudflare Access. With MD_PROXY_REQUIRE_CF_ACCESS=1 (default)
requests lacking the Cf-Access-Jwt-Assertion header are rejected (defence in depth; signature
verification is Cloudflare's job at the edge).
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Optional, Tuple
from urllib.parse import parse_qs, unquote

ALLOWED_SYMBOLS = frozenset({"XAUUSD", "BTCUSD"})
ALLOWED_TIMEFRAMES = frozenset({"M5", "M15", "H1", "H4"})
MAX_START = 1000
MAX_COUNT = 500
MAX_PATH_LEN = 128
MAX_QUERY_LEN = 128
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
UPSTREAM_TIMEOUT_S = 5.0
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
APPROVED_ROUTES = (
    ("GET", "/v1/health"),
    ("GET", "/v1/ticks/latest/{symbol}"),
    ("GET", "/v1/symbols/{symbol}"),
    ("GET", "/v1/bars/{symbol}/{timeframe}"),
)
_INT_RE = re.compile(r"^[0-9]{1,6}$")

log = logging.getLogger("md_proxy")


@dataclass(frozen=True)
class Rejection:
    status: int
    code: str


def _int(v: str, lo: int, hi: int) -> Optional[int]:
    if not _INT_RE.fullmatch(v):
        return None
    n = int(v)
    return n if lo <= n <= hi else None


def resolve(method: str, target: str) -> "str | Rejection":
    """Map a client request to a rebuilt upstream path, or a Rejection. Pure; no I/O."""
    if method not in ("GET", "OPTIONS"):
        return Rejection(405, "METHOD_NOT_ALLOWED")
    if len(target) > MAX_PATH_LEN + MAX_QUERY_LEN + 1 or "#" in target:
        return Rejection(400, "INVALID_REQUEST")
    path, sep, raw_q = target.partition("?")
    if len(path) > MAX_PATH_LEN or len(raw_q) > MAX_QUERY_LEN:
        return Rejection(400, "INVALID_REQUEST")
    if "%" in path or "\\" in path or "//" in path or ".." in path:
        return Rejection(404, "NOT_FOUND")
    seg = tuple(path.split("/")[1:]) if path.startswith("/") else ()
    try:
        q = parse_qs(raw_q, keep_blank_values=True, strict_parsing=bool(raw_q), max_num_fields=4) if raw_q else {}
    except ValueError:
        return Rejection(400, "INVALID_REQUEST")
    if sep and not raw_q:
        return Rejection(400, "INVALID_REQUEST")
    if any(len(v) != 1 for v in q.values()):
        return Rejection(400, "INVALID_REQUEST")
    a = {k: v[0] for k, v in q.items()}

    if seg == ("v1", "health"):
        return "/v1/health" if not a else Rejection(400, "INVALID_REQUEST")
    if len(seg) == 4 and seg[:3] == ("v1", "ticks", "latest"):
        if seg[3] not in ALLOWED_SYMBOLS:
            return Rejection(403, "SYMBOL_NOT_ALLOWED")
        return f"/v1/ticks/latest/{seg[3]}" if not a else Rejection(400, "INVALID_REQUEST")
    if len(seg) == 3 and seg[:2] == ("v1", "symbols"):
        if seg[2] not in ALLOWED_SYMBOLS:
            return Rejection(403, "SYMBOL_NOT_ALLOWED")
        return f"/v1/symbols/{seg[2]}" if not a else Rejection(400, "INVALID_REQUEST")
    if len(seg) == 4 and seg[:2] == ("v1", "bars"):
        sym, tf = seg[2], seg[3]
        if sym not in ALLOWED_SYMBOLS:
            return Rejection(403, "SYMBOL_NOT_ALLOWED")
        if tf not in ALLOWED_TIMEFRAMES:
            return Rejection(400, "INVALID_TIMEFRAME")
        if set(a) != {"mode", "start", "count"} or a["mode"] != "pos":
            return Rejection(400, "INVALID_REQUEST")
        start, count = _int(a["start"], 0, MAX_START), _int(a["count"], 1, MAX_COUNT)
        if start is None or count is None:
            return Rejection(400, "INVALID_REQUEST")
        return f"/v1/bars/{sym}/{tf}?mode=pos&start={start}&count={count}"
    return Rejection(404, "NOT_FOUND")


def parse_origins(raw: Optional[str]) -> frozenset[str]:
    out = set()
    for o in (raw or "").split(","):
        o = o.strip()
        if o.startswith("https://") and "*" not in o and o.count("/") == 2:
            out.add(o)
    return frozenset(out)


Fetch = Callable[[str], Tuple[int, bytes]]


def make_upstream_fetch(base: str, timeout: float = UPSTREAM_TIMEOUT_S, max_bytes: int = MAX_RESPONSE_BYTES) -> Fetch:
    host = base.split("://", 1)[-1].split("/", 1)[0].rsplit(":", 1)[0].strip("[]")
    if not base.startswith("http://") or host not in LOOPBACK_HOSTS:
        raise ValueError("upstream gateway must be loopback http")

    def fetch(upstream_path: str) -> Tuple[int, bytes]:
        req = urllib.request.Request(base.rstrip("/") + upstream_path, method="GET", headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (loopback only)
                status, stream = r.status, r
                body = stream.read(max_bytes + 1)
        except urllib.error.HTTPError as e:
            status, body = e.code, e.read(max_bytes + 1)
        if len(body) > max_bytes:
            raise OverflowError("upstream response too large")
        return status, body
    return fetch


@dataclass(frozen=True)
class ProxyResponse:
    status: int
    body: bytes
    headers: Tuple[Tuple[str, str], ...]


def handle(method: str, target: str, headers: dict[str, str], fetch: Fetch, origins: frozenset[str],
           require_cf_access: bool) -> ProxyResponse:
    """Full request handling, transport-independent (unit-testable)."""
    origin = headers.get("origin")
    cors: Tuple[Tuple[str, str], ...] = ()
    if origin is not None:
        if origin not in origins:
            return _err(403, "ORIGIN_NOT_ALLOWED", ())
        cors = (("Access-Control-Allow-Origin", origin), ("Vary", "Origin"),
                ("Access-Control-Allow-Methods", "GET, OPTIONS"),
                ("Access-Control-Allow-Headers", "accept"), ("Access-Control-Max-Age", "600"))
    r = resolve(method, target)
    if isinstance(r, Rejection):
        return _err(r.status, r.code, cors)
    if method == "OPTIONS":
        return ProxyResponse(204, b"", cors)
    if require_cf_access and not headers.get("cf-access-jwt-assertion"):
        return _err(401, "ACCESS_REQUIRED", cors)
    try:
        status, body = fetch(r)
    except OverflowError:
        return _err(502, "UPSTREAM_TOO_LARGE", cors)
    except Exception:  # timeout / refused — no internal detail leaves the process
        return _err(504, "UPSTREAM_UNAVAILABLE", cors)
    return ProxyResponse(status, body, cors + (("Content-Type", "application/json"),
                                               ("X-Proxy-Authority", "READ_ONLY_MARKET_DATA"),
                                               ("Cache-Control", "no-store")))


def _err(status: int, code: str, cors: Tuple[Tuple[str, str], ...]) -> ProxyResponse:
    return ProxyResponse(status, json.dumps({"error": code}).encode(), cors + (("Content-Type", "application/json"),))


class _Handler(BaseHTTPRequestHandler):
    server_version = "md-proxy"
    sys_version = ""

    def _serve(self) -> None:
        t0 = time.monotonic()
        hdrs = {k.lower(): v for k, v in self.headers.items()}
        cfg = self.server.cfg  # type: ignore[attr-defined]
        res = handle(self.command, self.path, hdrs, cfg["fetch"], cfg["origins"], cfg["require_cf_access"])
        self.send_response(res.status)
        for k, v in res.headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(res.body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(res.body)
        # Log method, path only (no query, headers, cookies or tokens).
        log.info("%s %s -> %d %.0fms", self.command, self.path.split("?", 1)[0][:MAX_PATH_LEN], res.status,
                 (time.monotonic() - t0) * 1000)

    do_GET = do_OPTIONS = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = _serve

    def log_message(self, format: str, *args: object) -> None:  # silence default access log (contains query)
        return


def build_server(host: str, port: int, fetch: Fetch, origins: frozenset[str], require_cf_access: bool) -> ThreadingHTTPServer:
    if host not in LOOPBACK_HOSTS:
        raise ValueError("md_proxy binds loopback only")
    srv = ThreadingHTTPServer((host, port), _Handler)
    srv.cfg = {"fetch": fetch, "origins": origins, "require_cf_access": require_cf_access}  # type: ignore[attr-defined]
    srv.timeout = 10
    return srv


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    port = int(os.environ.get("MD_PROXY_PORT", "8780"))
    upstream = os.environ.get("MD_PROXY_UPSTREAM", "http://127.0.0.1:8765")
    origins = parse_origins(os.environ.get("MD_PROXY_ALLOWED_ORIGINS"))
    require = os.environ.get("MD_PROXY_REQUIRE_CF_ACCESS", "1") != "0"
    srv = build_server("127.0.0.1", port, make_upstream_fetch(upstream), origins, require)
    log.info("md_proxy listening 127.0.0.1:%d origins=%d require_cf_access=%s", port, len(origins), require)
    srv.serve_forever()


if __name__ == "__main__":
    main()
