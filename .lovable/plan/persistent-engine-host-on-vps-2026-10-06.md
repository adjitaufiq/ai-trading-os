# Persistent Engine Host on VPS

Goal: the radar, paper loop, virtual account and journal run continuously on the Windows VPS. They survive a browser refresh, keep going with the dashboard closed, and come back automatically after a VPS reboot. The dashboard only attaches and reads.

Approved exception to the stage order (user-confirmed). Safety stays the same: MONITOR_ONLY, execution disabled, no order code anywhere.

## What the user gets
- Open or refresh the dashboard: radar shows ACTIVE right away with the latest snapshot. No re-warmup in the browser.
- Close the browser: the engine keeps evaluating every closed M5 bar and keeps writing the paper journal.
- VPS reboot: the engine service starts on its own, reloads the account and journal, bootstraps the radar again from broker history (about 1–2 min), then goes ACTIVE.
- Engine health on screen (STARTING → SYNCING → ONLINE → DEGRADED → OFFLINE) comes from the engine host, not from guesses in the browser.

## Architecture

```text
MT5 terminal -> Python gateway (loopback, unchanged)
                     |
              Engine Host (new, Node/Bun on VPS)
              - same MarketRuntime / Radar / LivePaperLoop code from src/core
              - state store: append-only files on VPS disk
              - read-only HTTP + SSE: /v1/engine/*
                     |
         Cloudflare tunnel (same as today)
                     |
              Dashboard (attach mode, read-only)
```

Storage lives on the VPS disk (append-only JSONL plus an atomic snapshot file), not in Lovable Cloud. The engine and its data stay on the same machine, so there's no network dependency on the trading loop, and no accounts or secrets go to the cloud.

## Steps
1. **Engine host package** (`engine-host/`): headless entry that builds one MarketRuntime per symbol (XAUUSD, BTCUSD) with LiveClock, a Node WebSocket factory and BrokerGatewayClient pointed at the loopback gateway. It reuses src/core unchanged and imports nothing from src/probe.
2. **Connection supervisor**: heartbeat, stale-stream detection, reconnect with backoff, one subscription per symbol, DEGRADED on failure. It never shows SYNCHRONIZED unless that's actually true.
3. **Persistence**: journal rows go to append-only JSONL (CLOSED trades are never rewritten). Virtual account and open paper positions are snapshotted atomically. On start: reload, then re-bootstrap radar from `/v1/bars` history. BACKFILL stays separate from live, as it is today.
4. **Read-only API**: `GET /v1/engine/health`, `/v1/engine/{symbol}/radar`, `/technical`, `/account`, `/journal`, plus an SSE stream for updates. Uses the same envelope style and has no write routes.
5. **Windows auto-start**: install script (Task Scheduler at boot with restart-on-failure) and a README for the VPS. The user runs it once on the VPS, since I can't access the VPS.
6. **Dashboard attach mode**: new typed `EngineHostClient`. If the engine host answers, the dashboard reads radar/account/journal from it and shows the source as ENGINE_HOST. If it doesn't, the dashboard falls back to the in-browser runtime with a clear "BROWSER SESSION — resets on refresh" label. No silent mixing of the two.
7. **Tests**: engine host boots against the fake gateway, restart restores account/journal, append-only guarantee, no order/execution imports, dashboard attach/fallback labeling.
8. Record the decision in AGENTS.md and update roadmap.md.

## Technical notes
- Runtime: Node 20+ or Bun on Windows, using the `ws` package for WebSocket. The Python gateway stays stdlib-only and untouched.
- The engine host binds to loopback and is exposed through the existing tunnel under a separate path/port. It's read-only, so reachability gives no authority.
- Not in scope: new strategy rules, threshold changes, UI redesign.

## What you need to do afterward
Install Node on the VPS, copy `engine-host/`, run the install script once, then expose it through the tunnel. I'll give step-by-step instructions.
