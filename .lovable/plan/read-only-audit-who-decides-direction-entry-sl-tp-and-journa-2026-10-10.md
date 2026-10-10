# Read-only audit: who decides direction, entry, SL/TP and journal, and where ARENA and M1B clash

This is an audit only. No code was changed, no tests were run, and no fixes are proposed. Every claim cites the source file.

## 1. Who decides what

| Decision | Owner (file / function) | Inputs | Output | Read by | Status |
|---|---|---|---|---|---|
| H4 trend | `operator.ts:132` `trendState` | H4 EMA21, H4 EMA50, H4 structure summary | UP / DOWN / MIXED / INSUFFICIENT | `operatorAnalysis` | CLEAN |
| Direction (primaryBias) | `operator.ts` `operatorAnalysis` (around line 446) | the H4 trend | BUY / SELL / null | slice view `primary_bias` (`tradingState.ts:106`), Radar, demo bridge, M2 gate | CLEAN |
| ARENA status | `operatorAnalysis` (around lines 451–470) | regime, primaryBias, H1 context | reason and HOLD/WAIT/entry status | Radar, UI, reference plan | DUPLICATE (see conflict C3) |
| M1B bias | `biasEngine.ts:12` `deriveBiasFromStructure`; `derivePhase` around line 36 | M1B H4/H1 structure | BULLISH / BEARISH / NEUTRAL, plus phase | M2 setup, journal `signalSource` (`LivePaperLoop.ts:301`) | DUPLICATE |
| Setup direction | M1B location → `createSetup` (`LivePaperLoop.ts:271`) | price location, reaction | setup BUY/SELL | paper loop | CLEAN (gated) |
| M2 direction gate | `LivePaperLoop.ts:260–274` | primaryBias provider (`MarketRuntime.ts:154–159`) | `NO_PRIMARY_BIAS` / `COUNTER_PRIMARY_BIAS` veto | paper loop | CLEAN |
| READY | `LivePaperLoop.ts:278` | setup lifecycle | READY event | pipeline log, readiness | CLEAN |
| M3 plan | `tradePlanEngine.ts:30–51` with `slCalculator.ts:26` | keyLevel, ATR, M15 swings | PLANNED or HOLD, plus SL/TP | paper open, demo intent | CONFLICT (see C1) |
| M4 risk | called from the paper loop, BLOCKED at `LivePaperLoop.ts:279` | plan, account | approve or block | paper open | CLEAN |
| Paper open | `LivePaperLoop.ts:307–311` | approved plan | EXECUTION event, `ApprovedPaperOpen` | `EngineHost.ts:116` → demo intent | CLEAN |
| Demo intent | `intent.ts:13–17` | M3 entry/SL/TP and slice `primary_bias` | intent | `DemoExecutionBridge` | CLEAN |
| Demo guards | `DemoExecutionBridge.ts:73–103` | the intent | block or send | VPS :8100 | CLEAN |

## 2. ARENA vs M1B

1. **The M2 gate reads ARENA primaryBias.**
   - `MarketRuntime.ts:157` calls `biasSlice.evaluateAt(asOf).primary_bias` at every closed M5 bar, in live mode only.
   - The gate itself is `LivePaperLoop.ts:260`. It blocks candidates before `createSetup` (line 265), drops a pending setup if the direction flips (line 262), and re-checks before READY (line 274).
2. **The demo bridge reads ARENA primaryBias only.** It does not read M1B bias. It reads M3/M4 only indirectly: an intent exists only after a paper open. Guard order:
   1. `MODE_NOT_DEMO` (line 73)
   2. `DUPLICATE_SIGNAL` (line 74)
   3. invalid plan (line 75)
   4. `BLOCKED_COUNTER_PRIMARY_BIAS` (lines 79–87)
   5. identity (line 90)
   6. positions (line 92)
   7. safety limits (line 98)
   8. `SYMBOL_INFO_UNAVAILABLE` (line 100)
   9. `LOT_BELOW_MINIMUM` (line 103)
   10. send
3. **ARENA BUY while M1B has no setup:** nothing happens. ARENA never creates a setup or an order by itself.
   **ARENA BUY while M1B proposes SELL:** the candidate is vetoed with `COUNTER_PRIMARY_BIAS` at `LivePaperLoop.ts:265`. The hierarchy is enforced in code at two places (the M2 gate and the bridge), not just by convention.
4. **There is no single resolver.** The gate and the bridge both enforce primaryBias against an M1B-proposed side. ARENA status (HOLD/WAIT/entry) and M1B READY are two separate decisions that are never compared.

## Conflicts

- **C1. Two SL/TP formulas.**
  - M3 (`slCalculator.ts:26`): SL = anchor ± ATR × buffer. TP comes from `tpCalculator`.
  - ARENA `buildSidePlan` (`tradingState.ts:321`, used at lines 232, 378 and 465): scalp SL plus a zone cap on TP.
  - The demo order uses M3 values (`intent.ts:13`). Radar and the reference plan show ARENA values. They are never compared at runtime (no comparison found), so the levels the operator sees can differ from the levels sent.
- **C2. Two bias calculations.** M1B `biasEngine.ts:12` vs ARENA `trendState` (`operator.ts:132`).
  - M1B is structure-only; ARENA requires EMA21/50 and structure.
  - M1B's bias is recorded in the journal (`LivePaperLoop.ts:301`) as `H4_<bias>`.
  - So the journal can say `H4_NEUTRAL` while primaryBias is BUY. This is wording only; it does not change any decision.
- **C3. ARENA status does not gate the paper/demo path.** ARENA can say HOLD (choppy regime, or H1 INSUFFICIENT) while M1B reaches READY and the demo bridge sends. The bridge checks only the direction, not ARENA status (`DemoExecutionBridge.ts:79–87`).
- **C4. Two swing detectors.**
  - ARENA `causalSwings` (`indicators.ts:91`) uses a fixed 2+2 window, with the first bar of an equal run owning the pivot.
  - M1B uses `SwingDetector` (`swingDetector.ts:39`).
  - The evidence feeding them differs: ARENA uses `TechnicalSliceService` (broker history plus live closed bars); M1B uses `radarEvidence` (`MarketRuntime.ts:162`), also history plus live closed bars, but merged separately.

## 3. H4 bias formula (`operator.ts:132–137`)

- **INSUFFICIENT** if EMA21 or EMA50 is not OK, or the structure is `INSUFFICIENT_HISTORY`.
- **UP** = EMA21 > EMA50 AND structure `HH_HL`.
- **DOWN** = EMA21 < EMA50 AND structure `LH_LL`.
- **MIXED** = anything else.
- It is a pure yes/no AND: no weights and no scores.
- Equal EMAs, or `EQUAL_HIGH`/`EQUAL_LOW`, fall to MIXED.
- `structureOf` (`indicators.ts:117–144`) builds the summary from the latest high label and the latest low label only.
- The MTF confidence numbers (`operator.ts:308`) are labels only and do not choose the direction.
- Inputs are closed H4 bars from the slice. For `evaluateAt`, these are broker history plus live closed bars, closed only.
- Warmup is set by the EMA warmup (EMA50 needs at least 50 bars) and by needing at least two labelled swings of each kind.
- `INSUFFICIENT` → primaryBias null → `NONE` → HOLD with reason `H4_TREND_INSUFFICIENT_HISTORY`.
- The one source of truth is the slice field `primary_bias` (`tradingState.ts:106`, built at line 562). The bridge reads it through `intent.ts:17`.

## 4. Structure: continuation vs reversal

- **ARENA labels (`indicators.ts:120–123`):** each high is HH, LH or EQUAL_HIGH compared with the previous high; each low is HL, LL or EQUAL_LOW compared with the previous low.
  - `structureEvents` (`operator.ts:166`) only reports `break_candidate` (close beyond the last confirmed swing).
  - There is no BOS or CHOCH label in ARENA (NOT FOUND).
  - Pullbacks and continuation are expressed only through the H1 context labels (`operator.ts:146–157`): PULLBACK_AGAINST_H4, RETURNING_TO_H4, REVERSAL_CANDIDATE.
- **M1B (`structureEngine.ts:5–45`):** trend is HH_HL, LH_LL or RANGE.
  - The structure break `BEARISH_MSS` fires only on a closed candle below the last confirmed low while the trend is HH_HL.
  - `derivePhase` (`biasEngine.ts:36`) gives CONTINUATION, PULLBACK, REVERSAL or RANGE.
- **Scenario — H4 makes HH, HL, HH, then price trades below the last HL:**
  - **ARENA, before the new low is confirmed as a swing:** the summary stays `HH_HL`, so trend stays UP and primaryBias stays BUY. `break_candidate` becomes `BREAK_DOWN_CANDIDATE`, but only for display.
  - **ARENA, after the new swing low is confirmed (2 bars later):** labels become HH + LL, so MIXED, primaryBias null, NONE.
  - **M1B:** the closed bar below the low gives `structureShift = BEARISH_MSS`. After confirmation the trend becomes RANGE, so bias is NEUTRAL.
- **Are BOS/CHOCH used in decisions?** ARENA's `break_candidate` is not read by `trendState` (NOT FOUND as a decision input). M1B's MSS is used only in `derivePhase`. Neither one decides direction.

## 5. Calculations done twice

| Quantity | ARENA | M1B | Can the inputs differ? |
|---|---|---|---|
| EMA 5/21/50 | `indicators.ts:26`, SMA seed | `emaCalculator.ts:12`, SMA seed, its own minimum history | Different warmup minimums and different evidence merge |
| ATR14 | `atrWilder` (`indicators.ts:37`) | `computeAtr` (`priceLocationEngine.ts:11`) | Yes |
| Swings | `causalSwings` (`indicators.ts:91`), M5–H4 | `SwingDetector`, M15/H1/H4 | Yes: different tie rule and confirmation details |
| Candle patterns | `readPatterns` (`operator.ts:113`), `engulfing` (`indicators.ts:192`) | `detectCandlePattern` (`candlePatternDetector.ts:11`) | Yes: different definitions |

All inputs are closed bars only on both sides.

## 6. SL/TP

- **M3:** `tradePlanEngine.ts:39–51` with `slCalculator.ts:26`.
- **ARENA:** `buildSidePlan` (`tradingState.ts:321`) for the reference plan (line 465), the Radar projection (line 378) and line 232.
- **Sent in the order:** M3's `plan.sl`/`plan.tp`, via `LivePaperLoop.ts:311` → `intent.ts:13`. The bridge only checks that the plan is valid (`DemoExecutionBridge.ts:75`).
- **Written to the journal:** M3 values (the paper journal and the demo records).
- **Compared at runtime:** NOT FOUND. The two will differ whenever the ATR source, the anchor swing or the zone cap differ.

## 7. Journal coverage

- **Paper trades:** closed trades are saved via `journal.saveTrade` (`LivePaperLoop.ts:227`) and written to VPS disk once each (`persistence.ts:41–45`).
- **Pipeline events:** READY / BLOCKED / EXECUTION / EXIT go to the in-memory ring (`EngineHost.ts:128`), then the disk outbox, then cloud `engine_events` (`events.server.ts:108`).
- **Cloud `engine_trades`:** written by `capture.server.ts:43`. Demo rows are written only when the order is FILLED and closed (`mappers.ts:57–59`).
- **Open/filled positions before close:**
  - In memory only: the paper open position (`LivePaperLoop.ts:307`) and the demo event log.
  - There is no `engine_trades` row for an open position. Searched for `OPEN`/`FILLED` in `capture.server.ts`: NOT FOUND.
  - The only record of the open is the EXECUTION pipeline event in `engine_events`.
- **Source for a demo trade:** the demo bridge event log (`types.ts:80`). Paper rows come from M1B/M3. They are kept separate by `data_source`.

## 8. Trace: ARENA BUY, M1B has no setup

1. Closed M5 bar → `MarketRuntime.ts:162` → `paper.onClosedM5`.
2. The provider returns `primary_bias = BUY`.
3. M1B produces no CANDIDATE: `evGate` is null and no setup is created (`LivePaperLoop.ts:265–271`).
4. The decision is recorded as no setup. No READY, plan, intent or bridge call happens.
5. ARENA status, whether HOLD or WAIT, has no effect on this path.
6. The Radar/UI shows ARENA's status and reference plan.
7. The journal records nothing for this bar. The cloud `engine_memory` row (`capture.server.ts:39`) keeps the Radar decision for that M5 bar.

## Verdicts

- **Single direction authority:** YES — primaryBias, enforced at the M2 gate and in the bridge. Entry approval is NOT single: ARENA status and M1B READY are independent of each other.
- **H4 bias defined and deterministic:** YES — a binary AND with no scoring.
- **Continuation vs reversal:** PARTIAL — no BOS/CHOCH in ARENA; a break shows up only as MIXED after the new swing is confirmed; M1B's MSS does not decide direction.
- **SL/TP single source:** NO — M3 vs `buildSidePlan`, never compared.
- **Journal covers open positions:** NO — only the EXECUTION event and memory; trade rows exist only after close.

## Limitations

- Line numbers inside `operatorAnalysis` are approximate offsets from line 404.
- The full M4 internals and the `SwingDetector` tie details were not re-read in this pass.
- Runtime behaviour (actual disagreement rates, live data) was not observed.
- Tests were not run.
