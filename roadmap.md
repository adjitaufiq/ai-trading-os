# Stage 3 PRE-2D gap closure
- [x] Patch B — R4 bootstrap + R6 observation identity (approved to proceed; independent source audit pending)
- [x] Patch C — R5 gap contract, R7 bounded retention, R8 internal vs broker bar (candidate for full PRE-2D audit)
- [ ] Full PRE-2D integration + regression + independent source audit (blocked: awaiting explicit user instruction)

## Patch B audit debt (must carry into Patch C / PRE-2D audit)
- [ ] D1: REJECT → AMBIGUOUS_COLLISION/ACCEPT_WITH_FLAG test change (tick_count 2→3) — confirm in source audit that only fingerprint-equal/identity-different cases changed; same raw_event_id stays EXACT_TRANSPORT_DUPLICATE.
- [x] D2: canonical MarketRuntime wires Gateway → client → Bootstrap → Identity → Pipeline → fanout → CandleStore (hermetic application-chain tests). Open: UI consumer migration; app start blocked on G2 (no verified broker-time offset).
- [ ] D3: Drain order (source_event_ms, connection_epoch, sequence, arrival) — tie-break must be deterministic processing order only, never inferred market/causal order; same-ms ambiguous occurrences must not gain transport-sequence "market truth".

## C1 retention
- [x] C1 Retention Contract v1 implemented (candidate for source audit; independent audit pending)

## Technical Validation Probe
- [x] v1a — BACKFILL + deterministic replay diagnostics (EMA5/21, ATR14, retrospective vs causal swing). Real gateway was unreachable during the run.
- [ ] v1b — application-wiring validation PASS on hermetic transport; real-data validation pending (gateway unreachable, G2 open).
- [ ] Real Vertical Slice v1 acceptance — code + 354 tests done; BLOCKED: gateway tunnel URL NXDOMAIN (needs new URL); canonical tick MarketRuntime mount blocked by G2 offset + WS deferred.
- [ ] Canonical unification: TechnicalSliceService now reads MarketRuntimeReader only; BLOCKED mounting real runtime: G2 offset + real /v1/stream WS 404. G2 note: broker raw_time_s observed later than bridge_received_at (do not fix by offset).
- [x] Live dashboard: XAUUSD/BTCUSD canonical runtimes mounted on the real gateway, LIVE_MUTATION flowing, AVAILABLE. Gateway contract debt (fix on the Windows gateway): live /v1/stream frames say capability "MARKET_DATA.TICK" instead of 3.0B-1 "MARKET_DATA.TICKS"; client accepts it only on LIVE stream frames and counts it (streamCapabilityAliasCount).

## Frontend presentation
- [ ] Localize all user-facing main dashboard and trading cockpit copy to concise Bahasa Indonesia; keep core states, contracts, and calculations unchanged.
