"""Public analysis view of the loopback Engine Host (127.0.0.1:8090). Pure field allowlist copy.

Only three upstream reads exist: /v1/engine/health, /v1/engine/snapshot, /v1/analysis/snr/{XAUUSD|BTCUSD}.
Every response is rebuilt from allowlisted keys: account is always null and trades always [], health drops
build/shadow. Nothing is computed; anything that fails to parse becomes 502 (never passthrough).
"""
from __future__ import annotations

import json
from typing import Optional

ENGINE_PATHS = ("/v1/engine/health", "/v1/engine/snapshot")
HEALTH_KEYS = ("operating_mode", "execution_enabled", "started_at", "persistence", "demo_execution")
SYMBOL_HEALTH_KEYS = ("symbol", "state", "last_update_at", "latency_ms", "radar_status", "mount_status", "restarts", "clock")
SYMBOLS = ("XAUUSD", "BTCUSD")


def is_engine_path(p: str) -> bool:
    return p in ENGINE_PATHS or p.startswith("/v1/analysis/snr/")


def _sym_health(h: object) -> Optional[dict]:
    if not isinstance(h, dict) or h.get("symbol") not in SYMBOLS:
        return None
    out = {k: h.get(k) for k in SYMBOL_HEALTH_KEYS if k in h}
    out["error"] = None  # free-text upstream errors never leave the VPS
    return out


def _health(d: dict) -> dict:
    out = {k: d[k] for k in HEALTH_KEYS if k in d}
    out["symbols"] = [s for s in (_sym_health(x) for x in d.get("symbols") or []) if s]
    return out


def _bundle(b: object) -> Optional[dict]:
    if not isinstance(b, dict) or b.get("symbol") not in SYMBOLS:
        return None
    return {
        "symbol": b["symbol"], "source": "ENGINE_HOST", "timestamp": b.get("timestamp"),
        "health": _sym_health(b.get("health")), "slice": b.get("slice"), "radar": b.get("radar"),
        "account": None, "trades": [], "live": b.get("live"), "last_m5_close": b.get("last_m5_close"),
    }


def sanitize(path: str, body: bytes) -> Optional[bytes]:
    """Return the public JSON body for an engine path, or None when the upstream body is not a valid envelope."""
    try:
        env = json.loads(body.decode("utf-8"))
    except Exception:
        return None
    if not isinstance(env, dict) or env.get("schema") != "engine-host-v1" or not isinstance(env.get("data"), dict):
        return None
    d = env["data"]
    if path == "/v1/engine/health":
        data = _health(d)
    elif path == "/v1/engine/snapshot":
        data = {"bundles": [x for x in (_bundle(b) for b in d.get("bundles") or []) if x]}
    else:
        data = d  # SNR: market-derived zones/swings only (dedicated host contract)
    return json.dumps({"schema": "engine-host-v1", "source": "ENGINE_HOST", "generated_at": env.get("generated_at"), "data": data},
                      separators=(",", ":")).encode()
