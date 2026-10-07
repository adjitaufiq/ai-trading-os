# Arena Engine Host (VPS)

Runs the radar, paper loop, virtual account and journal 24/7 on the Windows VPS, independent of any browser.
MONITOR_ONLY: read-only HTTP API, no order path. The MT5 gateway is unchanged.

## Install (one time)
1. Install Bun: `powershell -c "irm bun.sh/install.ps1 | iex"`
2. Get this repo on the VPS (git clone / pull), then in the repo root: `bun install`
3. Make sure the MT5 gateway is running on `http://127.0.0.1:8000`.
4. Elevated PowerShell in repo root:
   `powershell -ExecutionPolicy Bypass -File engine-host\install-windows.ps1`
5. Check: `curl http://127.0.0.1:8090/v1/engine/health`

The task `ArenaEngineHost` starts at boot and restarts on failure. If the MT5 terminal/gateway also auto-start, a VPS reboot recovers everything; the radar re-bootstraps from broker history (about 1–2 min).

## Expose to the dashboard
Run a second Cloudflare tunnel for port 8090: `cloudflared tunnel --url http://127.0.0.1:8090`
and give the resulting https URL to the dashboard as `VITE_ENGINE_HOST_URL`.

## Data
`engine-host/data/<SYMBOL>.state.json` — latest virtual account snapshot (atomic replace)
`engine-host/data/<SYMBOL>.journal.jsonl` — append-only paper journal (never rewritten)
`engine-host/data/engine-host.log` — log

## API (GET only)
`/v1/engine/health` · `/v1/engine/{SYMBOL}/radar` · `/v1/engine/{SYMBOL}/account` · `/v1/engine/{SYMBOL}/journal` · `/v1/engine/stream` (SSE health)

## API (read-only, GET only)
- `/v1/engine/health` — state per symbol (STARTING → BOOTSTRAP → SYNCING → ONLINE / DEGRADED / OFFLINE) + broker clock drift (NORMAL / DRIFT_WARNING > 3000 ms)
- `/v1/engine/{symbol}/radar`, `/v1/engine/{symbol}/market-context`
- `/v1/engine/account`, `/v1/engine/journal` (all symbols) and per-symbol `/v1/engine/{symbol}/account|journal`
- `/v1/engine/events` — SSE: HEALTH_UPDATE, RADAR_UPDATE, MARKET_CONTEXT_UPDATE (only on a new CLOSED-bar evaluation)

## Stage 10 DEMO lab (optional, default off)
1. Log the MT5 terminal into the **demo** account.
2. Start the demo execution gateway (loopback only, never tunnel it):
   `set DEMO_EXEC_TOKEN=<long random>` · `set DEMO_ACCOUNT_WHITELIST=<demo login>` · `set DEMO_SERVER_WHITELIST=<demo server>` · `cd vps && python -m mt5_exec.server`
3. Start the engine host with the same token/whitelists plus `EXECUTION_MODE=DEMO_STRESS_TEST` and `DEMO_CONTROL_URL=https://ai-trading-os.lovable.app/api/public/demo-control`.
4. Press "Jalankan demo lab" in the dashboard (starts STOPPED). Kill switch: dashboard "STOP DEMO EXECUTION" or create `engine-host/data/DEMO_KILL_SWITCH`.
Limits: 0.5% risk, 1 open position, 5 trades/day, 2% daily loss. Status: `GET /v1/engine/demo`. Log: `engine-host/data/demo-events.jsonl` (append-only).
