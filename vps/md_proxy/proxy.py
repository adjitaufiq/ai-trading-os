"""Read-only market-data proxy in front of the loopback MT5 gateway (default 127.0.0.1:8765).

Stdlib only. Static allowlist — NOT a generic forwarder:
  GET /v1/health
  GET /v1/ticks/latest/{XAUUSD|BTCUSD}
  GET /v1/symbols/{XAUUSD|BTCUSD}
  GET /v1/bars/{XAUUSD|BTCUSD}/{M5|M15|H1|H4}?mode=pos&start=<0..1000>&count=<1..500>
  GET /v1/engine/health, /v1/engine/snapshot, /v1/analysis/snr/{XAUUSD|BTCUSD}  (engine_view: loopback 8090,
      field allowlist; account=null, trades=[]; no other Engine Host route; MD_PROXY_ENGINE_VIEW=off disables)
  OPTIONS on the same paths (CORS preflight, allowlisted origins only)
Everything else -> 404/405/400 before any upstream call. The upstream path is rebuilt from
validated values; the client's raw path/query is never forwarded. No request headers, cookies or
credentials are forwarded upstream. The proxy has no route to the demo execution service (8100).

Auth design (MD_PROXY_ACCESS_MODE, default cf_access; public_market_data = Quick Tunnel phase, allowlisted
market data only, still rate limited): the proxy binds loopback only and is meant to be reached exclusively through a
Cloudflare named tunnel protected by Cloudflare Access. In cf_access mode every
GET must carry a Cf-Access-Jwt-Assertion that verifies cryptographically (access.AccessVerifier:
RS256 signature vs team JWKS, issuer, audience, exp/nbf); startup fails if team domain / AUD are unset.
Upstream redirects are never followed.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Optional, Tuple
from urllib.parse import parse_qs, unquote

from .access import NO_REDIRECT_OPENER, AccessVerifier
from . import engine_view

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
    if seg in (("v1", "engine", "health"), ("v1", "engine", "snapshot")):
        return "/" + "/".join(seg) if not a else Rejection(400, "INVALID_REQUEST")
    if len(seg) == 4 and seg[:3] == ("v1", "analysis", "snr"):
        if seg[3] not in ALLOWED_SYMBOLS:
            return Rejection(403, "SYMBOL_NOT_ALLOWED")
        return f"/v1/analysis/snr/{seg[3]}" if not a else Rejection(400, "INVALID_REQUEST")
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


class RateLimiter:
    """Token buckets: one global, one per client key (Cf-Connecting-IP via cloudflared). Injectable clock."""

    def __init__(self, per_client_rps: float = 5.0, per_client_burst: int = 20, global_rps: float = 30.0,
                 global_burst: int = 60, max_clients: int = 10000, clock: Callable[[], float] = time.monotonic):
        self.pc, self.pb, self.gr, self.gb, self.max, self.clock = per_client_rps, per_client_burst, global_rps, global_burst, max_clients, clock
        self.g = [float(global_burst), clock()]
        self.c: dict[str, list] = {}
        self.lock = threading.Lock()

    @staticmethod
    def _take(b: list, rate: float, burst: int, now: float) -> bool:
        b[0] = min(burst, b[0] + (now - b[1]) * rate); b[1] = now
        if b[0] >= 1:
            b[0] -= 1
            return True
        return False

    def allow(self, key: str) -> bool:
        with self.lock:
            now = self.clock()
            if len(self.c) >= self.max and key not in self.c:
                self.c.clear()
            b = self.c.setdefault(key[:64], [float(self.pb), now])
            if not self._take(b, self.pc, self.pb, now):
                return False
            return self._take(self.g, self.gr, self.gb, now)


Fetch = Callable[[str], Tuple[int, bytes]]
AccessCheck = Callable[[Optional[str]], bool]


class RedirectRefused(Exception):
    pass


def make_upstream_fetch(base: str, timeout: float = UPSTREAM_TIMEOUT_S, max_bytes: int = MAX_RESPONSE_BYTES) -> Fetch:
    host = base.split("://", 1)[-1].split("/", 1)[0].rsplit(":", 1)[0].strip("[]")
    if not base.startswith("http://") or host not in LOOPBACK_HOSTS:
        raise ValueError("upstream gateway must be loopback http")

    def fetch(upstream_path: str) -> Tuple[int, bytes]:
        req = urllib.request.Request(base.rstrip("/") + upstream_path, method="GET", headers={"Accept": "application/json"})
        try:
            with NO_REDIRECT_OPENER.open(req, timeout=timeout) as r:  # noqa: S310 (loopback only)
                status, body = r.status, r.read(max_bytes + 1)
        except urllib.error.HTTPError as e:
            if 300 <= e.code < 400:
                raise RedirectRefused() from None
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
           access: Optional[AccessCheck], limiter: Optional[RateLimiter] = None,
           engine_fetch: Optional[Fetch] = None) -> ProxyResponse:
    """`access` None ⇒ public_market_data mode (allowlisted market data only)."""
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
    if access is not None and not access(headers.get("cf-access-jwt-assertion")):
        return _err(401, "ACCESS_REQUIRED", cors)
    if limiter is not None and not limiter.allow(headers.get("cf-connecting-ip") or "local"):
        return _err(429, "RATE_LIMITED", cors + (("Retry-After", "1"),))
    engine = engine_view.is_engine_path(r)
    if engine and engine_fetch is None:
        return _err(404, "ENGINE_VIEW_DISABLED", cors)
    try:
        status, body = (engine_fetch if engine else fetch)(r)  # type: ignore[misc]
    except OverflowError:
        return _err(502, "UPSTREAM_TOO_LARGE", cors)
    except RedirectRefused:
        return _err(502, "UPSTREAM_REDIRECT_REFUSED", cors)
    except Exception:  # timeout / refused — no internal detail leaves the process
        return _err(504, "UPSTREAM_UNAVAILABLE", cors)
    if engine:
        if status != 200:
            return _err(503 if status >= 500 else 502, "ENGINE_VIEW_UNAVAILABLE", cors)
        clean = engine_view.sanitize(r, body)
        if clean is None:
            return _err(502, "ENGINE_VIEW_INVALID", cors)
        body = clean
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
        res = handle(self.command, self.path, hdrs, cfg["fetch"], cfg["origins"], cfg["access"], cfg.get("limiter"), cfg.get("engine_fetch"))
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


def build_server(host: str, port: int, fetch: Fetch, origins: frozenset[str], access: Optional[AccessCheck],
                 limiter: Optional[RateLimiter] = None, engine_fetch: Optional[Fetch] = None) -> ThreadingHTTPServer:
    if host not in LOOPBACK_HOSTS:
        raise ValueError("md_proxy binds loopback only")
    srv = ThreadingHTTPServer((host, port), _Handler)
    srv.cfg = {"fetch": fetch, "origins": origins, "access": access, "limiter": limiter, "engine_fetch": engine_fetch}  # type: ignore[attr-defined]
    srv.timeout = 10
    return srv


ACCESS_MODES = ("cf_access", "public_market_data")


def resolve_access_mode(raw: Optional[str]) -> str:
    """Default cf_access. Only the exact value 'public_market_data' skips Access (this proxy only); anything else fails."""
    mode = (raw or "cf_access").strip()
    if mode not in ACCESS_MODES:
        raise ValueError("MD_PROXY_ACCESS_MODE must be cf_access or public_market_data")
    return mode


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    port = int(os.environ.get("MD_PROXY_PORT", "8780"))
    upstream = os.environ.get("MD_PROXY_UPSTREAM", "http://127.0.0.1:8765")
    origins = parse_origins(os.environ.get("MD_PROXY_ALLOWED_ORIGINS"))
    mode = resolve_access_mode(os.environ.get("MD_PROXY_ACCESS_MODE"))
    access = AccessVerifier(os.environ.get("MD_PROXY_CF_TEAM_DOMAIN", ""), os.environ.get("MD_PROXY_CF_AUD", "")) if mode == "cf_access" else None
    if mode == "public_market_data":
        log.warning("PUBLIC_MARKET_DATA mode: allowlisted XAUUSD/BTCUSD market data is public; Access check skipped for this proxy only")
    engine_up = os.environ.get("MD_PROXY_ENGINE_UPSTREAM", "http://127.0.0.1:8090")
    engine_fetch = None if os.environ.get("MD_PROXY_ENGINE_VIEW", "on") == "off" else make_upstream_fetch(engine_up)
    srv = build_server("127.0.0.1", port, make_upstream_fetch(upstream), origins, access, RateLimiter(), engine_fetch)
    log.info("md_proxy listening 127.0.0.1:%d origins=%d access_mode=%s", port, len(origins), mode)
    srv.serve_forever()


if __name__ == "__main__":
    main()
