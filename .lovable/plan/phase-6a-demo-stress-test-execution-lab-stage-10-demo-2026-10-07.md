# Phase 6A — Demo Stress Test Execution Lab (Stage 10 DEMO)

Goal: validate the full chain Engine → Risk → Execution → MT5 Demo → Journal → Review → Analytics with real demo fills. Not for profit.

## Execution modes
- `REAL_DISABLED` (default), `PAPER_ONLY`, `DEMO_STRESS_TEST`.
- No code path to a real account exists. MONITOR_ONLY stays for AI Assistant, LLM, real accounts and manual override.

## Order trigger (no human, no AI)
An order is sent only when ALL hold on a CLOSED M5:
engine READY + Risk Engine APPROVED + valid TradePlan + RR rule met + account validator PASS + safety limits PASS.

## Account validator (identity binding)
Allowed only if: account mode = DEMO AND account number in whitelist AND broker server in whitelist. Anything else (real, unknown account, unknown server) blocks execution and logs why. Checked at boot and before every order.

## Risk profile (initial)
- Risk per trade 0.5% of demo balance
- Max 1 open position (no stacking)
- Max 5 trades/day
- Max daily loss 2% → execution stops until next UTC day

## Safety
- Idempotency: one `signal_id` → at most one order (persisted on VPS, survives restart).
- Kill switch "STOP DEMO EXECUTION": blocks new orders immediately; existing SL/TP stay at broker.
- Full append-only execution log: request, broker response (accepted/rejected/filled/closed), latency, slippage.

## Journal per order
Trade ID, timestamps, symbol, regime, H4 bias, H1 state, setup, confidence, reasons, planned vs actual entry, SL, TP, lot, risk, execution result, exit reason, final outcome, engine snapshot. Captured into cloud `engine_trades` with `data_source = DEMO_MT5`, kept separate from REAL_MT5 paper and SYNTHETIC in all analytics. AI Review and Performance read it unchanged.

## Unchanged
Radar, signal evaluator, confidence, Trade Policy, Risk rules, Engine decision. AI stays analysis-only.

## Technical details
- VPS Python: new `vps/mt5_exec/` module, separate from the read-only bridge. Own native proxy whitelisting only `order_send`, `order_check`, `positions_get`, `history_deals_get`, `account_info`. Refuses unless `account_info().trade_mode == DEMO` and login/server are in `DEMO_ACCOUNT_WHITELIST`/`DEMO_SERVER_WHITELIST` env. Read-only bridge AGENTS rule stays true (its whitelist is not widened).
- Execution gateway: separate loopback-only process/port with one typed POST `/v1/demo/orders` + GET status; requires `DEMO_EXEC_TOKEN` shared with engine host only. Never exposed via the dashboard tunnel.
- Engine host: `DemoExecutionBridge` (src/core/execution/demo) subscribes to existing LivePaperLoop APPROVED plans, applies safety limits + idempotency store (JSONL), calls the exec gateway, records events to the journal. Engine host API stays GET-only; kill switch = local file flag + operator-only cloud toggle the host polls.
- Dashboard: read-only Demo Lab panel (mode, account check, limits used, open position, log) + operator-only kill switch button. No order button.
- Project rules/memory updated: Stage 10 DEMO opened; frontend still has no order code.
- Tests: validator (real/unknown blocked), idempotency, limits, kill switch, journal mapping, DEMO_MT5 separation.
- Live check needs you: install new VPS module, set whitelist + token env on the VPS.
