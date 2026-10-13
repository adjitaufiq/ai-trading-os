# Engine Status Agent (Windows/VPS)

Outbound-only. Reads `http://127.0.0.1:8090` (`/v1/engine/health`, `/v1/engine/execution-status`),
keeps only allowlisted fields, HMAC-signs and POSTs to `https://ai-trading-os.lovable.app/api/public/agent/engine-status`
every 15s. No inbound port, no tunnel, no writes to Engine Host, no order path.

Sent fields only: engine, mode, execution, mt5, shadow, kill_switch, signal, stale, phase, stage,
blockers (codes only), symbols (XAUUSD/BTCUSD), engine_checked_at, engine_reachable.
Never sent: balance, equity, login, server, positions, volume, entry/SL/TP, journal, raw responses.

## Install
```powershell
# copy vps\status_agent\ to C:\trading-os\status_agent\  (Python 3.10+, stdlib only)
[Environment]::SetEnvironmentVariable("ENGINE_STATUS_AGENT_SECRET", "<same value as backend secret>", "User")
$env:ENGINE_STATUS_AGENT_SECRET = [Environment]::GetEnvironmentVariable("ENGINE_STATUS_AGENT_SECRET","User")
cd C:\trading-os
python -m status_agent.agent --once     # expect: push=200 engine=ONLINE phase=WAITING_SETUP reachable=True
python -m status_agent.agent            # run continuously (or register as a Task Scheduler / NSSM service)
```
Optional env: `STATUS_RELAY_URL` (default published app), `STATUS_AGENT_ID` (default `vps-1`), `STATUS_PUSH_INTERVAL_S` (default 15).

## Verify
- `https://ai-trading-os.lovable.app/api/public/engine-status` → `status: ONLINE`, small `heartbeat_age_ms`.
- Dashboard banner shows `STATUS RELAY: ENGINE ONLINE · WAITING_SETUP …`.
- Stop the agent > 2 min → next 5-min capture sends Telegram ENGINE OFFLINE; restart → BACK ONLINE on first heartbeat.

## Rollback
Stop the agent process and delete `C:\trading-os\status_agent\`; remove the user env var. Engine Host is untouched.
