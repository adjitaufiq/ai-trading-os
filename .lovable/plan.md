# Audit (read-only): Dashboard, Market Data, Engine Host, MT5, Telegram

Nothing changed: no code, config, build, publish, tunnel, restart, or order.

## 1. Current system (facts from code, live state UNKNOWN unless stated)

```text
Browser (ai-trading-os.lovable.app)
 |-- quote/candle --> Quick Tunnel cited-mainly --> md_proxy :8780 --> MT5 gateway :8765
 |      (allowed: GET /v1/health, /v1/ticks/latest/{sym}, /v1/symbols/{sym}, /v1/bars/{sym}/{tf})
 |      (blocked: /v1/terminal -> 404, /v1/stream WebSocket -> not proxied)
 |-- status banner --> Quick Tunnel bit-testimony --> status_proxy :8782 --> Engine Host :8090
 |      (reads only /v1/engine/execution-status + /v1/health; sanitized)
 |-- Engine Host full view (SSE/snapshot) --> VITE_ENGINE_HOST_URL = EMPTY --> DISABLED
 |      -> fallback BROWSER SESSION: mounts local runtime that needs /v1/stream WS (not available)
 |-- /api/public/engine-status (cloud relay) -- used only if VITE_ENGINE_STATUS_URL empty

Cloud backend (Telegram, ~5 min capture)
 |-- reads relay table engine_status_relay <-- VPS status_agent (HMAC push)  [agent not running: UNKNOWN/likely]
 |-- VITE_ENGINE_HOST_URL fallback for capture -> empty

VPS (localhost only)
 Engine Host :8090 --> MT5 gateway :8765 (market data)
                  --> Demo exec :8100 (token, shadowGatedGateway) --> MT5 DEMO
```

## 2. Route / data table

| Data | Source (local) | Route | Consumer | Access now | Sensitivity |
|---|---|---|---|---|---|
| Quote | gateway 8765 | /v1/ticks/latest/{sym} | RealMarketTerminal | public via 8780 tunnel | public market |
| Candles | gateway 8765 | /v1/bars/{sym}/{tf} | chart, runtime warmup | public via 8780 | public market |
| Symbol spec | gateway 8765 | /v1/symbols/{sym} | runtime | public via 8780 | public market |
| Terminal info | gateway 8765 | /v1/terminal | MT5 lamp | blocked (404) | account-adjacent |
| Live ticks stream | gateway 8765 | WS /v1/stream | browser runtime | not reachable | public market |
| Indicators/Radar/Context/Analysis | Engine Host 8090 | /v1/engine/events (SSE), /snapshot, /{sym}/radar, /market-context, /v1/analysis/snr/{sym} | TechnicalSlicePanel, SNR | not reachable (URL empty) | mostly market-derived, but bundle includes trades/account |
| Status | Engine Host 8090 | /v1/engine/execution-status | status_proxy, agent | sanitized via 8782 | sanitized OK |
| Account/journal/demo/readiness/pipeline/shadow/monitoring | Engine Host 8090 | /v1/engine/account, /journal, /demo, ... | none public | localhost only | SENSITIVE |
| Orders | Demo exec 8100 | token-protected | Engine Host only | localhost only | CRITICAL |
| Telegram status | cloud relay table | agent push | capture job | backend | sanitized |

## 3. Gaps causing broken UI / Telegram

1. Indicators, Radar, Analysis empty: `VITE_ENGINE_HOST_URL` empty, so dashboard falls back to browser runtime, which needs `/v1/stream` WebSocket that md_proxy does not serve. Fact.
2. MT5 terminal lamp "gangguan": `/v1/terminal` deliberately blocked. Fact.
3. `snapshot.symbols` empty: status_proxy reads `/v1/health` instead of `/v1/engine/health`. Fact (previous audit).
4. Telegram ONLINE/OFFLINE: relies on relay heartbeat; status_agent not confirmed running on VPS → NO_DATA/OFFLINE. UNKNOWN on VPS.
5. Quick Tunnel URLs change on restart → each change needs rebuild/publish. Fact.
6. Engine Host bundle mixes market analysis with trades/account; exposing it raw is unsafe. Fact.

## 4. Options

| | A. Separate tunnels per path | B. One controlled reverse proxy | C. Cloud backend intermediary |
|---|---|---|---|
| Local ports served | 8780, 8782, + new analysis proxy | one proxy (e.g. 8785) routing to 8765/8090 allowlist | VPS agent pushes outbound; no inbound |
| Tunnels | 3 Quick Tunnels | 1 Quick Tunnel | 0 (or 1 for market data) |
| Browser endpoints | market + status + analysis allowlist | same allowlist, one host | same-origin /api/public/* |
| Auth / exposure | public, allowlisted, sanitized | public, allowlisted, sanitized | HMAC agent; browser sees only sanitized copy |
| CORS / rebuild | 3 origins, 3 env vars | 1 origin, 1 env var | none for status/analysis |
| URL change impact | up to 3 republishes | 1 republish | none (outbound) |
| One service down | isolated | proxy per-route 503, others ok | stale heartbeat → OFFLINE after 120s |
| Order/account protection | allowlist, no 8100 | allowlist, no 8100, strip account fields | strict zod schema, nothing else stored |

Recommendation: B for market data + analysis (one tunnel, one URL), C for status + Telegram (already built, no tunnel dependency). Status_proxy 8782 retired after C is verified.

## 5. Target architecture

```text
Browser
 |-- market + analysis --> 1 Quick Tunnel --> view_proxy :8785
 |        /v1/ticks|symbols|bars        -> 8765 (as md_proxy today)
 |        /v1/view/{sym}/analysis      -> 8090 /v1/engine/{sym}/snapshot, ONLY technical/radar/context/snr fields copied (no trades/account)
 |        /v1/view/terminal            -> 8765 /v1/terminal, only connected/trade_allowed flags
 |-- status --> same-origin /api/public/engine-status (cloud relay)
Cloud backend: relay table <- status_agent (outbound HMAC, 15s) ; Telegram reads relay (120s stale = debounce)
VPS: 8090 / 8765 / 8100 stay localhost; 8100 never proxied.
```

Dashboard renders analysis read-only from the proxy (polling, no SSE), never mounts a browser runtime when the view proxy is reachable.

## 6. Phased implementation (after approval)

1. Status agent on VPS (no code change): run agent, verify `push=200`, relay ONLINE. Pass: `/api/public/engine-status` ONLINE, Telegram BACK ONLINE once. Rollback: stop agent.
2. Fix status_proxy health path (1 line) or skip if C replaces it. Pass: symbols non-empty.
3. Build view_proxy (stdlib, tests allow/deny incl. account/journal/demo/8100 denied, field allowlist). Pass: tests green, local curl shows analysis without account fields. Rollback: stop process.
4. Dashboard: read analysis from view proxy, status from relay; single env var. Pass: browser shows quote, candle, indicators, Radar, Analysis, ENGINE ONLINE · WAITING_SETUP. Rollback: republish previous env.
5. Telegram verification: stop agent briefly → OFFLINE alert after threshold only; restart → BACK ONLINE. No spurious alert on single timeout.

## 7. Trading alignment

Plan touches only display/status. Unchanged: Engine Host, strategy, signals, Decision Gate, Risk, DEMO mode, Shadow, arm, active symbols, positions, MT5 gateway, demo exec 8100, auto-execution. Execution keeps waiting for a valid setup; no order is forced to test the dashboard.

## 8. Decisions needed before BUILD

1. Approve recommended mix (B + C) or choose A / pure C.
2. Is it acceptable for market-derived analysis (indicators, radar, SNR, context) to be public read-only without login?
3. Show MT5 connected/disconnected flag publicly, or keep MT5 lamp from relay only?
4. Retire status_proxy 8782 after relay works, or keep as backup?
5. Run status_agent as a Windows service (auto-start) or manual window?

## UNKNOWN

Whether status_agent is running on VPS; current liveness of each Quick Tunnel; VPS service manager; exact Engine Host build on VPS.
