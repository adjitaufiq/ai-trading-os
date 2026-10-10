# Execution Readiness Monitor (design only)

A read-only panel that shows where the path from H4 bias to a demo order stops. It does not change trading logic, guards, risk caps or execution, and it has no order button.

## A. Data source for each indicator

Market / setup readiness (Engine Host, per symbol)
| Indicator | Source today | Gap |
|---|---|---|
| PrimaryBias (BUY/SELL/NONE, as_of) | `TechnicalSliceService` slice → `bundle.slice.current.primary_bias` | as_of is not exposed in the bundle |
| M2 setup status | `LivePaperLoop` (setup state, NO_SETUP / COUNTER_PRIMARY_BIAS / NO_PRIMARY_BIAS / SETUP_INVALIDATED) | Only in memory; not in the bundle |
| M3 plan status | `LivePaperLoop` → `buildTradePlan` result | Not exposed |
| M4 decision + block reason | `LivePaperLoop` → `evaluateRisk` result | Not exposed |

Execution readiness
| Indicator | Source today | Gap |
|---|---|---|
| EXECUTION_MODE (host) | engine-host env → `EngineHostHealth.demo_execution` | Already exposed |
| demo_enabled, kill_switch, cloud mode, limits | cloud `execution_config` + `deriveControl` (`/api/public/demo-control`) | Already readable |
| Agent heartbeat age | cloud `execution_agent_status` | Already readable |
| DemoExecutionBridge status | `DemoExecutionBridge.status()` (account check, open count, trades today, daily loss, last event) | Shown via `/v1/engine/demo` when mounted |
| Port 8100 gateway reachable | bridge `gateway.account()` result (`IDENTITY_UNAVAILABLE` when down) | No dedicated probe result/timestamp |
| MT5 connection | read-only gateway health (`/v1/health`) + per-symbol `SymbolEngineHealth.state` | Exposed |

Persistence
| Indicator | Source today |
|---|---|
| Open demo positions | `DemoExecutionBridge.status().openPositions` (from gateway `positions()`) |
| Filled orders / rejected / errors | bridge event log (FILLED / REJECTED / ERROR) |
| Closed trades | bridge CLOSED events / `records()` |
| Journal state | cloud `engine_trades` count by `data_source = DEMO_MT5`, latest row time |

## B. UI recommendation

- One "Execution Readiness" card per symbol (XAUUSD, BTCUSD) on the existing Demo Lab area.
- A vertical chain of lamps, top to bottom: H4 bias → M2 setup → M3 plan → M4 risk → Cloud control → Bridge → Gateway 8100 → MT5 account → Broker result → Journal.
- Each lamp: PASS / BLOCKED / UNKNOWN (grey, never green when data is missing or stale) plus the exact engine reason code and its age.
- A headline line: "First stop: <stage> — <reason>" taken from the priority order below.
- Counters for today: setups, plans, M4 approvals, send attempts, fills, rejections, closes, journal rows.
- Honest labels: DEMO, NOT CONNECTED, STALE; data older than a threshold turns UNKNOWN.

## C. Failure reason priority (first match is the headline)

1. Engine Host unreachable / snapshot error
2. MT5 / market feed not ONLINE (BOOTSTRAP, DEGRADED, OFFLINE)
3. Host EXECUTION_MODE not DEMO_STRESS_TEST
4. Cloud halt: kill switch, demo disabled, cloud mode not demo, config missing or stale
5. Demo gateway 8100 unreachable
6. Account check failed (not demo, not whitelisted login/server)
7. Safety limits hit (open positions, trades/day, daily loss)
8. PrimaryBias NONE / MIXED
9. M2: no setup, counter primary bias, invalidated
10. M3: no valid plan
11. M4: rejected (with reason)
12. Bridge block (duplicate, invalid plan, counter primary bias, lot below minimum, symbol info)
13. Broker rejection / send error (retcode)
14. Journal write missing (fill exists, no `engine_trades` row)

## D. Files affected if built later

Engine Host (read-only additions)
- `src/core/paper/LivePaperLoop.ts` — expose last gate/M2/M3/M4 outcome as a read-only view (no logic change)
- `src/core/enginehost/types.ts`, `EngineHost.ts`, `api.ts` — add a `readiness` field to the symbol bundle / demo status
- `src/core/execution/demo/DemoExecutionBridge.ts` — expose last gateway probe time/result in `status()`
- `engine-host/main.ts` — pass the bundle field through

Dashboard
- New `src/components/ExecutionReadinessPanel.tsx`
- New pure mapper `src/lib/executionReadiness.ts` (priority order, no calculations)
- `src/components/DemoLabPanel.tsx` / `src/routes/index.tsx` — mount the panel
- Reads existing cloud tables via existing control functions (`src/lib/control/control.functions.ts`)

Tests
- Mapper priority-order tests; bundle shape test in `src/test/engine-host.test.tsx`

Not touched: M2/M3/M4 rules, DemoExecutionBridge guards, VPS files, risk caps, database schema.

## Next step

Approve with a BUILD header to implement; suggested split: (1) engine read-only fields, (2) dashboard panel.
