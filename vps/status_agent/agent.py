"""Engine status agent (read-only, outbound only).

Reads ONLY http://127.0.0.1:8090 (GET health + execution-status), builds an allowlisted minimal
snapshot, HMAC-signs it with ENGINE_STATUS_AGENT_SECRET and POSTs it over HTTPS to the backend relay.
It never forwards raw Engine Host responses, account data, positions, prices or journal entries, never
writes to the engine and has no order path. Python stdlib only.
"""
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ENGINE_BASE = "http://127.0.0.1:8090"
RELAY_PATH = "/api/public/agent/engine-status"
SCHEMA = "engine-status-relay-v1"
USER_AGENT = "ArenaStatusAgent/2"
SYMBOLS = ("XAUUSD", "BTCUSD")
CODE = re.compile(r"^[A-Z0-9_]{1,48}$")
ENUMS = {
    "engine": {"ONLINE", "DEGRADED", "OFFLINE"},
    "mode": {"MONITOR_ONLY", "DEMO_EXECUTION"},
    "execution": {"READY", "WAITING_SIGNAL", "ACTIVE", "BLOCKED", "UNKNOWN"},
    "mt5": {"CONNECTED", "DISCONNECTED", "UNKNOWN"},
    "shadow": {"CLEAR", "BLOCKING"},
    "signal": {"READY", "WAITING", "UNKNOWN"},
}
PHASES = {"MONITOR_ONLY", "DEMO_CONNECTED", "WAITING_SETUP", "SIGNAL", "DEMO_EXECUTION"}
DEFAULTS = {"engine": "OFFLINE", "mode": "MONITOR_ONLY", "execution": "UNKNOWN", "mt5": "UNKNOWN", "shadow": "BLOCKING", "signal": "UNKNOWN"}


def _code(v):
    return v if isinstance(v, str) and CODE.match(v) else None


def sanitize(execution, health, now_ms):
    """Allowlist copy. Anything not explicitly listed (balance, equity, login, server, positions,
    prices, journal, checklist details, transitions) is dropped by construction."""
    ex = execution if isinstance(execution, dict) else None
    snap = {"schema": SCHEMA}
    for k, allowed in ENUMS.items():
        v = ex.get(k) if ex else None
        snap[k] = v if v in allowed else DEFAULTS[k]
    snap["kill_switch"] = bool(ex.get("kill_switch")) if ex else False
    snap["stale"] = bool(ex.get("stale", True)) if ex else True
    auto = ex.get("automation") if ex and isinstance(ex.get("automation"), dict) else {}
    snap["phase"] = auto.get("phase") if auto.get("phase") in PHASES else None
    snap["stage"] = _code(auto.get("stage"))
    raw_b = ex.get("blockers") if ex and isinstance(ex.get("blockers"), list) else []
    snap["blockers"] = [b for b in (_code(x) for x in raw_b) if b][:12]
    syms = []
    if isinstance(health, dict):
        for s in health.get("symbols") or []:
            name = s.get("symbol") if isinstance(s, dict) else None
            if name in SYMBOLS and name not in syms:
                syms.append(name)
    snap["symbols"] = syms
    ca = ex.get("checked_at") if ex else None
    snap["engine_checked_at"] = int(ca) if isinstance(ca, (int, float)) and ca >= 0 else int(now_ms)
    snap["engine_reachable"] = ex is not None
    return snap


def sign(secret, ts, method, path, body):
    msg = f"{ts}\n{method.upper()}\n{path}\n{body}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def read_local(path, timeout=5.0):
    """GET from the local Engine Host only; returns envelope.data or None."""
    try:
        with urllib.request.urlopen(ENGINE_BASE + path, timeout=timeout) as r:
            if r.status != 200:
                return None
            data = json.loads(r.read(2_000_000).decode("utf-8"))
            return data.get("data") if isinstance(data, dict) else None
    except Exception:
        return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def push(relay_base, secret, agent_id, snapshot, now_ms, opener=None, timeout=10.0):
    if not relay_base.startswith("https://"):
        raise ValueError("relay must be https")
    body = json.dumps({"agent_id": agent_id, "snapshot": snapshot}, separators=(",", ":"))
    ts = str(int(now_ms))
    req = urllib.request.Request(relay_base.rstrip("/") + RELAY_PATH, data=body.encode("utf-8"), method="POST", headers={
        "User-Agent": USER_AGENT, "Content-Type": "application/json", "x-agent-timestamp": ts, "x-agent-signature": sign(secret, ts, "POST", RELAY_PATH, body)})
    op = opener or urllib.request.build_opener(_NoRedirect)
    try:
        with op.open(req, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def main():
    secret = os.environ.get("ENGINE_STATUS_AGENT_SECRET", "")
    relay = os.environ.get("STATUS_RELAY_URL", "https://ai-trading-os.lovable.app")
    agent_id = os.environ.get("STATUS_AGENT_ID", "vps-1")
    interval = max(5, int(os.environ.get("STATUS_PUSH_INTERVAL_S", "15")))
    once = "--once" in sys.argv
    if not secret:
        print("ENGINE_STATUS_AGENT_SECRET not set", file=sys.stderr)
        return 2
    while True:
        now = time.time() * 1000
        snap = sanitize(read_local("/v1/engine/execution-status"), read_local("/v1/engine/health"), now)
        try:
            code = push(relay, secret, agent_id, snap, now)
        except Exception as e:  # never log secrets; only the error class
            code = f"ERR {type(e).__name__}"
        print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} push={code} engine={snap['engine']} phase={snap['phase']} reachable={snap['engine_reachable']}", flush=True)
        if once:
            return 0 if code == 200 else 1
        time.sleep(interval)


if __name__ == "__main__":
    sys.exit(main())
