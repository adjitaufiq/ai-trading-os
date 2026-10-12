# ARENA Engine Host — Deploy Package 83c752f
Source commit: 83c752f7ec503713b3972f26a4479557df6dbe4e (working tree clean). Built: 2026-10-12T03:10:30Z. Current VPS version: bae9120.
Includes: Status Synchronization (83aa298), Research Intelligence V1 (94b3764), Signal Lifecycle Hardening V1 (700600ca, 83c752f).
NOT changed: strategy/M1B, Decision Gate, risk engine, Shadow Guard, execution/order logic, SL/TP.

## Validation before packaging
- Typecheck: PASS (exit 0)
- Full suite: 1090/1093 in parallel run; 3 failures were 5s timeouts under load (c1-retention, dualAsset, radarRuntime); re-run isolated 37/37 PASS. Total 1093/1093 logic PASS.

## Changelog since bae9120
- Status Sync: GET /v1/engine/execution-status (read-only, schema engine-execution-status-v1); health reports real DEMO/MONITOR_ONLY; dashboard accepts DEMO health; ENGINE/MODE/EXECUTION shown separately; EXE lamp reads only execution-status (grey/red/yellow/green, stale >30s never green); SNR endpoint /v1/analysis/snr/{SYMBOL}; tightened architecture tests.
- Research Intelligence V1: post-trade attribution, setup ranking (>=20 trades), regime memory, expectancy/PF/MaxDD/hold time, strategy conclusion only >=50 trades (dashboard only).
- Signal Hardening V1: pre-READY context check (H4 bias 12h, M15 60min, M5 15min) -> SIGNAL_REJECTED with reason; DUPLICATE_BLOCKED for identical active signal (released on EXPIRED/INVALIDATED); CONTEXT_LOST after READY invalidates; regime label frozen in snapshot (UNCERTAIN when no regime source); active signals persisted across restart; rejected signals kept in audit trail.

## Changed files (non-test, since bae9120)
- engine-host/BUILD_INFO.json
- engine-host/main.ts
- src/components/MobileTerminalChrome.tsx
- src/components/MobileTradingView.tsx
- src/components/PerformancePanel.tsx
- src/core/enginehost/AGENTS.md
- src/core/enginehost/EngineHost.ts
- src/core/enginehost/api.ts
- src/core/enginehost/client.ts
- src/core/enginehost/executionStatus.ts
- src/core/enginehost/snr.ts
- src/core/enginehost/types.ts
- src/core/paper/AGENTS.md
- src/core/paper/LivePaperLoop.ts
- src/core/paper/signalHardening.ts
- src/engine/journal/types.ts
- src/lib/engineHostStore.ts
- src/lib/exeLamp.ts
- src/lib/review/AGENTS.md
- src/lib/review/research.ts
- src/routes/index.tsx

## Backup (on VPS, before deploy)
1. Stop engine-host service.
2. Copy whole current folder: e.g. `cp -r arena-engine-host arena-engine-host.bak-bae9120` (Windows: robocopy).
3. Separately copy `engine-host/data/` (paper account snapshot + journal JSONL) to a safe place.

## Deploy
1. Unzip over a fresh folder; copy back `engine-host/data/` and your .env (EXECUTION_MODE, DEMO_* etc. unchanged).
2. `bun install`, start engine host as before. Gateway stays 127.0.0.1:8765. Keep SHADOW until checks pass.

## Rollback
1. Stop service. 2. Restore `arena-engine-host.bak-bae9120` folder. 3. Keep current `data/` (journal is append-only; new fields like REJECTED records/activeSignals are ignored by old code). 4. Start; verify /v1/engine/version = bae9120.

## Post-deploy health checks
- GET /v1/engine/version -> commit "83c752f".
- GET /v1/engine/execution-status -> schema engine-execution-status-v1, stale=false.
- Dashboard bottom bar shows ENGINE ONLINE · MODE <MONITOR_ONLY|DEMO_EXECUTION> · <status> · Ns.
- EXE lamp: grey if no engine; red MONITOR_ONLY/BLOCKED/kill switch/stale; yellow WAITING SIGNAL; green only READY/ACTIVE.
- Journal: existing trades still load; new READY/REJECTED records carry regime + reason; no duplicate READY after restart.
- Research: Performance panel shows "Research Intelligence V1" (INSUFFICIENT DATA under 50 trades is expected).


---

## v3 scope correction (2026-10-12 03:45 UTC)

Phase 4A (`67a502f`, `fd8c23f`) is an ancestor of the CURRENT VPS baseline `bae9120`
(verified: `git merge-base --is-ancestor`). It is already running on the VPS and is
NOT part of this deploy delta. Reverting it would change live risk behaviour, so nothing is removed.

### Included changes (bae9120 -> 83c752f)
- Status Synchronization `83aa298`
- Research Intelligence V1 `94b3764`
- Signal Lifecycle Hardening V1 `700600c`, `83c752f`
- SNR endpoint (`snr.ts`), already reviewed before Status Sync

### Excluded
- Phase 4A: already in baseline, zero diff in this delta
- Everything after `83c752f` (`a46d29c`, `8a1a725`, BUILD_INFO only)

### Scope verification vs bae9120
- `src/core/execution/**`, `src/engine/risk/**`, `engine-host/risk-policy.json`, ShadowGuard: 0 lines changed
- LivePaperLoop: no risk/lot/riskPercent lines changed (only context validation, dedup, regime)
- engine-host/main.ts: only adds observation hooks (kill switch / reconciliation labels for execution-status)

### Non-test files changed
engine-host/BUILD_INFO.json, engine-host/main.ts, src/components/MobileTerminalChrome.tsx,
src/components/MobileTradingView.tsx, src/components/PerformancePanel.tsx,
src/core/enginehost/{EngineHost,api,client,executionStatus,snr,types}.ts,
src/core/paper/{LivePaperLoop,signalHardening}.ts, src/engine/journal/types.ts,
src/lib/engineHostStore.ts, src/lib/exeLamp.ts, src/lib/review/research.ts, src/routes/index.tsx

### Validation
- Typecheck: exit 0
- Full suite: 1093/1093 passed (99 files)
