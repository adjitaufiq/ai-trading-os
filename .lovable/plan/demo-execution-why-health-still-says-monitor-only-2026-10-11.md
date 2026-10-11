# DEMO execution: why health still says MONITOR_ONLY

## Findings (read-only)

1. **What forces MONITOR_ONLY:** `src/core/enginehost/EngineHost.ts:178`, inside `health()`, has `operating_mode: "MONITOR_ONLY", execution_enabled: false` written as fixed text. It is only a label. It does not read any config, and it does not block orders. No env flag can change it. The field that actually shows the mode is `demo_execution` on the same response. In DEMO it should say `DEMO_STRESS_TEST` (`main.ts:107`).
2. **No flag left to flip.** Seeing `[demo-lab] EXECUTION_MODE=DEMO armed` (`main.ts:198`) means the demo order path is wired up.
3. **Gates that can still hold an order (`main.ts`):**
   - **Shadow Guard (line 95):** it stays on if `SHADOW_MODE=ON` is set. Check `/v1/engine/health` → `shadow.label`. It must not say "SHADOW — NO ORDERS".
   - **Emergency stop (line 100):** `emergency_stop: true` in `risk-policy.json`, or an `EMERGENCY_STOP` or `DEMO_KILL_SWITCH` file in the data folder.
   - **Cloud kill switch (lines 178–189):** if `DEMO_CONTROL_URL` is set, orders stay blocked until it answers `stopped=false`. If `CONTROL_PLANE_URL` + `EXECUTION_AGENT_SECRET` are set, the cloud execution settings must be armed. To test standalone, leave both unset.
   - **Reconciliation (line 172):** if the engine's records don't match the broker's positions, new orders are blocked.
   - **Account state (line 126):** if the demo account can't be read for more than 60 s, approvals are blocked.
   - **Risk limits:** max 1 position / 1 symbol / daily trade cap / 2% daily loss, plus the broker's minimum lot.
   - **Signal:** an order only goes out after a real READY → M4 APPROVED. There is no manual order.

## Proposed minimal change (optional, label only)

Make `health()` show the real state instead of fixed text:
- `operating_mode`: `DEMO` when the demo path is armed, otherwise `MONITOR_ONLY`
- `execution_enabled`: true only when the demo path is armed AND shadow is off AND no kill switch is active
- `demo_execution`: unchanged

Files: `EngineHost.ts` (health), `engine-host/main.ts` (pass armed/kill state), plus a health test. No change to the order path, risk, Shadow Guard, Decision Gate or strategy. You'd need a new deploy package.

## Fastest check without a code change

Run `GET /v1/engine/health`. Expect `demo_execution: "DEMO_STRESS_TEST"` and a shadow label that is not "NO ORDERS". Then run `GET /v1/engine/readiness` to see which gate is BLOCKED, and `GET /v1/engine/demo` to see the kill switch and recent events.
