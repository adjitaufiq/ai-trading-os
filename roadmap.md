# Stage 3 PRE-2D gap closure
- [x] Separate assistant chat, control and research pages; preserved panel logic; verified panel order and navigation at 320/390/1280 widths without overflow or page errors; 14 targeted tests and lint passed; automatic build OK.
- [x] Assistant mobile cockpit: full-width chat, conversation drawer, all reports/audit retained; verified 320/390/768/1280 widths, composer typing, 16 assistant tests, lint and automatic build/typecheck; historical demo audit is compatible with AI-only MONITOR_ONLY, old unqualified header was ambiguous; no trading changes.
- [x] Telegram presentation: safe Markdown→HTML, professional briefing prompt, clean alerts/Q&A, parser fallback; 913 regression tests passed and automatic build/typecheck OK.
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
- [x] Trader Radar Dashboard v2.1 — presentation-only HOLD visual guard, separated Market/Setup/Execution layers, trader-readable runtime cards, and distinct real-feed timestamps.
- [x] Trader Radar v2.1 final guardrails — explicit projection-only architecture, unchanged backend enums, grouped card contract, stale-data labeling, live REAL_MT5 and mobile verification.
- [x] Trader Radar navigation patch — mobile bottom navigation, restored Signal → Context → Plan lifecycle, and one shared UI projection for signal/plan direction.
- [x] Localize all user-facing main dashboard and trading cockpit copy to concise Bahasa Indonesia; keep core states, contracts, and calculations unchanged.
- [x] Deterministic reference plan v1 — H1 RSI gate, confirmed H1 swing ± 0.25× ATR14(M15), TP1 1R, TP2 2R; read-only MONITOR_ONLY.

- [x] Operator-v2 engine polish (H4 primary/H1 context, S/R zones, EMA21/50 confluence, M15/M5 RSI support, candle patterns v1, regime, trader summary)

- [x] Paper/simulation trades, journal (signal transitions + paper trades), quick backtest, compact AI payload

- [x] M1B.8 Institutional Footprint Radar + optional footprints on M2 SignalSetup / M6 JournalTrade (passive evidence)
- [ ] M8 Optimization Laboratory (blocked: awaiting user verification of M1B.8)

## Persistent engine host
- [x] Engine host (VPS): runtime per symbol, paper snapshot + append-only journal on disk, supervisor remount, GET-only API + SSE, Windows auto-start script; dashboard Radar/Account attach with BROWSER SESSION fallback. Verified booting against live gateway (XAUUSD/BTCUSD ONLINE, radar ACTIVE in <40s).
- [ ] Install on VPS + second tunnel for port 8090 + set VITE_ENGINE_HOST_URL (blocked: needs user on VPS).
- [ ] TRADE/ANALYSIS technical cards still computed in the browser (re-warm from broker history on refresh); host-side technical view not yet exposed.
