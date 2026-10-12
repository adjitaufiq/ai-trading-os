# Status Synchronization Fix (observability only)

Scope: make Engine Host VPS status → status API → every dashboard/mobile indicator one chain. No changes to strategy, signal generator, Decision Gate, risk engine, Shadow Guard logic, or order execution. No VPS deploy; package only after acceptance tests pass and on separate approval.

## 1. Health validation (dashboard)
- `client.ts` `isEngineHostHealth`: accept `operating_mode` MONITOR_ONLY | DEMO and boolean `execution_enabled`, still strict on shape/enums; unknown values stay INVALID.
- `engineHostStore.ts`: stop discarding DEMO health on HEALTH_UPDATE.

## 2. New read-only endpoint `GET /v1/engine/execution-status`
Pure copy of facts the host already holds (no recalculation):
```text
{ engine: ONLINE|DEGRADED|OFFLINE,
  mode: MONITOR_ONLY|DEMO_EXECUTION,
  execution: READY|WAITING_SIGNAL|ACTIVE|BLOCKED|UNKNOWN,
  account: PASS|FAIL|UNKNOWN, mt5: CONNECTED|DISCONNECTED|UNKNOWN,
  shadow: CLEAR|BLOCKING, kill_switch: bool,
  risk: PASS|BLOCKED|UNKNOWN, reconciliation: CLEAN|MISMATCH|UNKNOWN,
  stale: bool, blockers: string[], checked_at }
```
Sources: demo bridge arm state + last account identity (with timestamp), shadow status, kill switches (policy file, EMERGENCY_STOP/DEMO_KILL_SWITCH, cloud, halt), last reconciliation, last recorded M4 outcome, symbol health freshness. Missing/old data = UNKNOWN/stale, never PASS. Also pushed on SSE as part of health.

## 3. Three separate statuses in UI
- ENGINE: ONLINE / DEGRADED / OFFLINE
- MODE: MONITOR_ONLY / DEMO_EXECUTION (LIVE_EXECUTION never produced — real account absent)
- EXECUTION: READY / WAITING_SIGNAL / ACTIVE / BLOCKED / UNKNOWN

## 4. EXE lamp (mobile + desktop), read only from execution-status
- Green "EXE READY": engine ONLINE, account PASS, MT5 CONNECTED, risk PASS, kill switch OFF, shadow CLEAR, reconciliation CLEAN, not stale, and a valid signal present.
- Yellow "EXE ARMED · WAITING SIGNAL": everything safe but no signal / risk not yet evaluated.
- Red "EXE BLOCKED": MT5 disconnected, kill switch ON, risk blocked, shadow blocking, mismatch, stale, or MONITOR_ONLY.
- Remove hardcoded MONITOR_ONLY / EXECUTION OFF text in `MobileTradingView.tsx`, `MobileTerminalChrome.tsx`, desktop trade panel; browser session without host shows "NOT CONNECTED".

Note: your Condition 1 expects yellow WAITING SIGNAL and Condition 2 green READY — plan follows that (green only with a valid signal and all gates).

## 5. Acceptance tests (vitest, before any package)
1. Engine online, no signal → ENGINE ONLINE, MODE DEMO_EXECUTION, EXE yellow WAITING SIGNAL.
2. Valid signal + all gates pass → EXE green READY.
3. Kill switch active → EXE red BLOCKED.
4. Stale/missing data → never green.
5. Dashboard accepts DEMO health (no INVALID_ENVELOPE); unknown modes rejected.
Plus full suite + typecheck.

## After approval
Implement → tests → report → STOP. Deploy package is a separate request.
